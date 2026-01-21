const { Client, GatewayIntentBits, EmbedBuilder, Events } = require('discord.js');
const { Octokit } = require('@octokit/rest');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
// Optional "default" channel (used as fallback).
const DEFAULT_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
// NOTE: This must be the GitHub *login/slug* (the bit in the URL), not the display name.
// Supports both organization-owned and user-owned Projects V2.
const GITHUB_OWNER = process.env.GITHUB_OWNER || process.env.GITHUB_ORG;
const PROJECT_NUMBER = process.env.PROJECT_NUMBER;

// Routing config:
// - USER_MAPPINGS: GitHub login -> Discord user ID (for @mentions + DM fallback)
// - DEV_CHANNEL_MAPPINGS: GitHub login -> Discord channel ID (send to each dev's channel)
const DEV_CHANNEL_MAPPINGS_ENV = process.env.DEV_CHANNEL_MAPPINGS || process.env.USER_CHANNEL_MAPPINGS;
const devChannelMappings = new Map();
if (DEV_CHANNEL_MAPPINGS_ENV) {
    try {
        const mappings = JSON.parse(DEV_CHANNEL_MAPPINGS_ENV);
        Object.entries(mappings).forEach(([github, channelId]) => {
            if (channelId) devChannelMappings.set(github, String(channelId));
        });
    } catch (e) {
        console.error('Invalid DEV_CHANNEL_MAPPINGS JSON:', e);
    }
}

// Behavior toggles
const RUN_ON_STARTUP = String(process.env.RUN_ON_STARTUP || '').toLowerCase() === 'true';
const SUPPRESS_INITIAL_ASSIGNMENT_NOTIFICATIONS =
    String(process.env.SUPPRESS_INITIAL_ASSIGNMENT_NOTIFICATIONS || '').toLowerCase() !== 'false'; // default: true
const PING_ON_ASSIGNMENTS = String(process.env.PING_ON_ASSIGNMENTS || '').toLowerCase() !== 'false'; // default: true
const PING_ON_DEADLINES = String(process.env.PING_ON_DEADLINES || '').toLowerCase() !== 'false'; // default: true
const NOTIFY_UNASSIGNED_DEADLINES_TO_DEFAULT_CHANNEL =
    String(process.env.NOTIFY_UNASSIGNED_DEADLINES_TO_DEFAULT_CHANNEL || '').toLowerCase() === 'true';

// Initialize clients
const discord = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const octokit = new Octokit({
    auth: GITHUB_TOKEN
});

// Store user mappings (GitHub username -> Discord user ID)
const userMappings = new Map();
// Load from environment or configuration file
if (process.env.USER_MAPPINGS) {
    const mappings = JSON.parse(process.env.USER_MAPPINGS);
    Object.entries(mappings).forEach(([github, discord]) => {
        userMappings.set(github, discord);
    });
}

// Store previous state of assignments (issue/PR URL -> assignee usernames)
const STORAGE_FILE = path.join(__dirname, 'assignment-state.json');
let previousAssignments = new Map();
let hasLoadedAssignmentState = false;

// Load previous assignments from file
function loadPreviousAssignments() {
    try {
        if (fs.existsSync(STORAGE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
            previousAssignments = new Map(Object.entries(data));
            hasLoadedAssignmentState = true;
            console.log('Loaded previous assignment state');
        }
    } catch (error) {
        console.error('Error loading previous assignments:', error);
    }
}

// Save current assignments to file
function savePreviousAssignments() {
    try {
        const data = Object.fromEntries(previousAssignments);
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error saving assignments:', error);
    }
}

async function getProjectItems() {
    const number = parseInt(PROJECT_NUMBER, 10);
    if (!GITHUB_OWNER || Number.isNaN(number)) {
        console.error(
            'Missing config: set GITHUB_OWNER (or GITHUB_ORG) to your GitHub login/slug, and PROJECT_NUMBER to a number.'
        );
        console.error('Examples: GITHUB_OWNER=ComfortDevInnov (from https://github.com/ComfortDevInnov), PROJECT_NUMBER=1');
        return [];
    }

    const queryBody = `
        projectV2(number: $number) {
            id
            items(first: 100) {
                nodes {
                    id
                    fieldValues(first: 20) {
                        nodes {
                            ... on ProjectV2ItemFieldDateValue {
                                date
                                field {
                                    ... on ProjectV2FieldCommon {
                                        name
                                    }
                                }
                            }
                            ... on ProjectV2ItemFieldTextValue {
                                text
                                field {
                                    ... on ProjectV2FieldCommon {
                                        name
                                    }
                                }
                            }
                            ... on ProjectV2ItemFieldSingleSelectValue {
                                name
                                field {
                                    ... on ProjectV2FieldCommon {
                                        name
                                    }
                                }
                            }
                        }
                    }
                    content {
                        ... on Issue {
                            number
                            title
                            url
                            assignees(first: 10) {
                                nodes {
                                    login
                                }
                            }
                            repository {
                                name
                            }
                        }
                        ... on PullRequest {
                            number
                            title
                            url
                            assignees(first: 10) {
                                nodes {
                                    login
                                }
                            }
                            repository {
                                name
                            }
                        }
                    }
                }
            }
        }
    `;

    // Try organization-owned project first
    try {
        const project = await octokit.graphql(
            `
            query($login: String!, $number: Int!) {
                organization(login: $login) {
                    ${queryBody}
                }
            }
            `,
            { login: GITHUB_OWNER, number }
        );

        return project?.organization?.projectV2?.items?.nodes || [];
    } catch (error) {
        const message = error?.message || '';
        if (message.includes('Could not resolve to an Organization')) {
            console.error(
                `GitHub org not found for login "${GITHUB_OWNER}". If you used a display name (with spaces), replace it with the URL slug (e.g. https://github.com/<slug>).`
            );
        } else {
            console.error('Error fetching org project items:', error);
        }
    }

    // Fallback: user-owned project
    try {
        const project = await octokit.graphql(
            `
            query($login: String!, $number: Int!) {
                user(login: $login) {
                    ${queryBody}
                }
            }
            `,
            { login: GITHUB_OWNER, number }
        );

        return project?.user?.projectV2?.items?.nodes || [];
    } catch (error) {
        console.error('Error fetching user project items:', error);
        return [];
    }
}

function getDeadlineFromItem(item) {
    const dateFields = item.fieldValues.nodes.filter(
        node => node.field && (
            node.field.name.toLowerCase().includes('deadline') ||
            node.field.name.toLowerCase().includes('due date') ||
            node.field.name.toLowerCase() === 'date'
        )
    );
    
    if (dateFields.length > 0 && dateFields[0].date) {
        return new Date(dateFields[0].date);
    }
    return null;
}

function isDeadlineToday(deadline) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const deadlineDate = new Date(deadline);
    deadlineDate.setHours(0, 0, 0, 0);
    return deadlineDate.getTime() === today.getTime();
}

function isDeadlineTomorrow(deadline) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const deadlineDate = new Date(deadline);
    deadlineDate.setHours(0, 0, 0, 0);
    return deadlineDate.getTime() === tomorrow.getTime();
}

function getDiscordUserIdForGithubLogin(githubLogin) {
    return userMappings.get(githubLogin);
}

function getMentionsForGithubLogins(githubLogins) {
    return githubLogins
        .map(login => getDiscordUserIdForGithubLogin(login))
        .filter(Boolean)
        .map(id => `<@${id}>`)
        .join(' ');
}

function getTargetsForGithubLogins(githubLogins) {
    // Returns array of targets: { type: 'channel', id } or { type: 'dm', userId }
    const targets = [];
    const seen = new Set();

    for (const login of githubLogins) {
        const channelId = devChannelMappings.get(login);
        if (channelId) {
            const key = `channel:${channelId}`;
            if (!seen.has(key)) {
                targets.push({ type: 'channel', id: channelId, githubLogin: login });
                seen.add(key);
            }
            continue;
        }

        const userId = getDiscordUserIdForGithubLogin(login);
        if (userId) {
            const key = `dm:${userId}`;
            if (!seen.has(key)) {
                targets.push({ type: 'dm', userId, githubLogin: login });
                seen.add(key);
            }
        }
    }

    return targets;
}

async function sendToTarget(target, payload) {
    if (target.type === 'channel') {
        const channel = await discord.channels.fetch(target.id);
        await channel.send(payload);
        return;
    }
    if (target.type === 'dm') {
        const user = await discord.users.fetch(target.userId);
        await user.send(payload);
        return;
    }
    throw new Error(`Unknown target type: ${target.type}`);
}

async function checkDeadlinesAndNotify() {
    console.log('Checking for upcoming deadlines...');
    
    const items = await getProjectItems();
    const todayItems = [];
    const tomorrowItems = [];

    items.forEach(item => {
        if (!item.content) return;

        const deadline = getDeadlineFromItem(item);
        if (!deadline) return;

        if (isDeadlineToday(deadline)) {
            todayItems.push(item);
        } else if (isDeadlineTomorrow(deadline)) {
            tomorrowItems.push(item);
        }
    });

    // Send notifications for today's deadlines
    for (const item of todayItems) {
        await sendDeadlineNotification(item, 'TODAY', '#ff0000');
    }

    // Send notifications for tomorrow's deadlines
    for (const item of tomorrowItems) {
        await sendDeadlineNotification(item, 'TOMORROW', '#ffa500');
    }

    console.log(`Found ${todayItems.length} items due today and ${tomorrowItems.length} items due tomorrow`);
}

async function checkNewAssignments() {
    console.log('Checking for new assignments...');
    
    const items = await getProjectItems();
    const currentAssignments = new Map();
    const newAssignments = [];

    // Build current state
    items.forEach(item => {
        if (!item.content) return;
        
        const content = item.content;
        const assignees = content.assignees.nodes.map(a => a.login);
        currentAssignments.set(content.url, assignees);

        // Check for new assignments
        if (previousAssignments.has(content.url)) {
            const oldAssignees = previousAssignments.get(content.url);
            const newAssignees = assignees.filter(a => !oldAssignees.includes(a));
            
            if (newAssignees.length > 0) {
                newAssignments.push({
                    item,
                    newAssignees
                });
            }
        } else if (assignees.length > 0) {
            // New item with assignees
            newAssignments.push({
                item,
                newAssignees: assignees
            });
        }
    });

    // Baseline behavior:
    // If we have no stored state, don't notify for existing assignments; just record current state and start "going forward".
    if (!hasLoadedAssignmentState && SUPPRESS_INITIAL_ASSIGNMENT_NOTIFICATIONS) {
        previousAssignments = currentAssignments;
        savePreviousAssignments();
        hasLoadedAssignmentState = true;
        console.log('No previous assignment state found. Baseline created; skipping initial assignment notifications.');
        return;
    }

    // Send notifications for new assignments (going forward)
    for (const { item, newAssignees } of newAssignments) {
        await sendNewAssignmentNotifications(item, newAssignees);
    }

    // Update stored state
    previousAssignments = currentAssignments;
    savePreviousAssignments();
    hasLoadedAssignmentState = true;

    console.log(`Found ${newAssignments.length} new assignments`);
}

async function sendNewAssignmentNotifications(item, newAssignees) {
    const content = item.content;
    const deadline = getDeadlineFromItem(item);

    const targets = getTargetsForGithubLogins(newAssignees);
    const fallbackTargets = [];
    if (targets.length === 0 && DEFAULT_CHANNEL_ID) {
        fallbackTargets.push({ type: 'channel', id: DEFAULT_CHANNEL_ID });
    }

    const mentionText = PING_ON_ASSIGNMENTS ? getMentionsForGithubLogins(newAssignees) : '';
    const contentText = `${mentionText ? `${mentionText} ` : ''}You've been assigned to a new ticket!`;

    const embed = new EmbedBuilder()
        .setColor('#00ff00')
        .setTitle(`🎯 New Assignment: ${content.title}`)
        .setURL(content.url)
        .addFields(
            { name: 'Repository', value: content.repository.name, inline: true },
            { name: 'Issue/PR', value: `#${content.number}`, inline: true }
        )
        .setTimestamp();

    if (deadline) {
        embed.addFields({ name: 'Deadline', value: deadline.toDateString(), inline: true });
    }

    embed.addFields({
        name: 'Newly Assigned',
        value: newAssignees.map(a => `@${a}`).join(', ')
    });

    const payload = { content: contentText, embeds: [embed] };
    const sendTargets = targets.length > 0 ? targets : fallbackTargets;

    for (const target of sendTargets) {
        await sendToTarget(target, payload);
    }
}

async function sendDeadlineNotification(item, when, color) {
    const content = item.content;
    const assignees = content.assignees.nodes;
    const deadline = getDeadlineFromItem(item);

    const assigneeLogins = assignees.map(a => a.login);
    const targets = getTargetsForGithubLogins(assigneeLogins);

    const fallbackTargets = [];
    if (
        targets.length === 0 &&
        DEFAULT_CHANNEL_ID &&
        (NOTIFY_UNASSIGNED_DEADLINES_TO_DEFAULT_CHANNEL || assignees.length === 0)
    ) {
        fallbackTargets.push({ type: 'channel', id: DEFAULT_CHANNEL_ID });
    }

    const mentionText = PING_ON_DEADLINES ? getMentionsForGithubLogins(assigneeLogins) : '';

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`⚠️ Deadline ${when}: ${content.title}`)
        .setURL(content.url)
        .addFields(
            { name: 'Repository', value: content.repository.name, inline: true },
            { name: 'Issue/PR', value: `#${content.number}`, inline: true },
            { name: 'Deadline', value: deadline.toDateString(), inline: true }
        )
        .setTimestamp();

    if (assignees.length > 0) {
        embed.addFields({
            name: 'Assignees',
            value: assignees.map(a => `@${a.login}`).join(', ')
        });
    }

    const payload = { content: mentionText || undefined, embeds: [embed] };
    const sendTargets = targets.length > 0 ? targets : fallbackTargets;

    for (const target of sendTargets) {
        await sendToTarget(target, payload);
    }
}

// Discord bot ready event
// (discord.js v15+ renamed "ready" to "clientReady"; this keeps you compatible across versions)
discord.once(Events?.ClientReady ?? 'clientReady', () => {
    console.log(`Logged in as ${discord.user.tag}`);
    console.log('Bot is ready and monitoring deadlines!');
    
    // Load previous assignment state
    loadPreviousAssignments();
    
    // Avoid "redeploy spam" by default: rely on scheduled cron checks.
    // Opt-in if you want a run immediately at startup.
    if (RUN_ON_STARTUP) {
        checkDeadlinesAndNotify();
        checkNewAssignments();
    } else {
        console.log('Startup checks skipped (RUN_ON_STARTUP=false). Waiting for scheduled checks.');
    }
});

// Schedule deadline checks - runs every day at 9 AM
cron.schedule('0 9 * * *', () => {
    checkDeadlinesAndNotify();
});

// Check for new assignments every 15 minutes
cron.schedule('*/15 * * * *', () => {
    checkNewAssignments();
});

// You can also add a manual trigger command
discord.on('messageCreate', async (message) => {
    if (message.content === '!check-deadlines' && message.member.permissions.has('Administrator')) {
        await message.reply('Checking deadlines...');
        await checkDeadlinesAndNotify();
    }
    
    if (message.content === '!check-assignments' && message.member.permissions.has('Administrator')) {
        await message.reply('Checking for new assignments...');
        await checkNewAssignments();
    }
});

// Login to Discord
discord.login(DISCORD_TOKEN);