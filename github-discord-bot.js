const { Client, GatewayIntentBits, EmbedBuilder, Events } = require('discord.js');
const { Octokit } = require('@octokit/rest');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
// NOTE: This must be the GitHub *login/slug* (the bit in the URL), not the display name.
// Supports both organization-owned and user-owned Projects V2.
const GITHUB_OWNER = process.env.GITHUB_OWNER || process.env.GITHUB_ORG;
const PROJECT_NUMBER = process.env.PROJECT_NUMBER;

// Initialize clients
const discord = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
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

// Load previous assignments from file
function loadPreviousAssignments() {
    try {
        if (fs.existsSync(STORAGE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
            previousAssignments = new Map(Object.entries(data));
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

    const channel = await discord.channels.fetch(CHANNEL_ID);

    // Send notifications for today's deadlines
    for (const item of todayItems) {
        await sendNotification(channel, item, 'TODAY', '#ff0000');
    }

    // Send notifications for tomorrow's deadlines
    for (const item of tomorrowItems) {
        await sendNotification(channel, item, 'TOMORROW', '#ffa500');
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

    // Send notifications for new assignments
    if (newAssignments.length > 0) {
        const channel = await discord.channels.fetch(CHANNEL_ID);
        
        for (const { item, newAssignees } of newAssignments) {
            await sendNewAssignmentNotification(channel, item, newAssignees);
        }
    }

    // Update stored state
    previousAssignments = currentAssignments;
    savePreviousAssignments();

    console.log(`Found ${newAssignments.length} new assignments`);
}

async function sendNewAssignmentNotification(channel, item, newAssignees) {
    const content = item.content;
    const deadline = getDeadlineFromItem(item);

    // Build mention string
    let mentions = '';
    const discordMentions = newAssignees
        .map(username => userMappings.get(username))
        .filter(id => id)
        .map(id => `<@${id}>`)
        .join(' ');
    
    if (discordMentions) {
        mentions = discordMentions + ' ';
    }

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

    await channel.send({
        content: `${mentions}You've been assigned to a new ticket!`,
        embeds: [embed]
    });
}

async function sendNotification(channel, item, when, color) {
    const content = item.content;
    const assignees = content.assignees.nodes;
    const deadline = getDeadlineFromItem(item);

    // Build mention string
    let mentions = '';
    if (assignees.length > 0) {
        const discordMentions = assignees
            .map(a => userMappings.get(a.login))
            .filter(id => id)
            .map(id => `<@${id}>`)
            .join(' ');
        
        if (discordMentions) {
            mentions = discordMentions + ' ';
        }
    }

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

    await channel.send({
        content: mentions || undefined,
        embeds: [embed]
    });
}

// Discord bot ready event
// (discord.js v15+ renamed "ready" to "clientReady"; this keeps you compatible across versions)
discord.once(Events?.ClientReady ?? 'clientReady', () => {
    console.log(`Logged in as ${discord.user.tag}`);
    console.log('Bot is ready and monitoring deadlines!');
    
    // Load previous assignment state
    loadPreviousAssignments();
    
    // Run initial check
    checkDeadlinesAndNotify();
    checkNewAssignments();
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