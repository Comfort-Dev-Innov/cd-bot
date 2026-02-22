const { Client, GatewayIntentBits, EmbedBuilder, Events } = require('discord.js');
const { Octokit } = require('@octokit/rest');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const express = require("express");
const app = express();

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("CD Bot is alive.");
});

app.listen(PORT, () => {
  console.log("Web server running.");
});

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

function parseCommaList(raw, fallbackCsv) {
    const base = String((raw == null || String(raw).trim() === '') ? fallbackCsv : raw);
    return base
        .split(',')
        .map(s => String(s).trim())
        .map(s => s.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim())
        .filter(Boolean);
}

const DEADLINE_EXCLUDE_STATUS_NAMES = (process.env.DEADLINE_EXCLUDE_STATUS_NAMES || 'Done')
    ? parseCommaList(process.env.DEADLINE_EXCLUDE_STATUS_NAMES, 'Done')
    : ['Done'];

// Daily "idle devs" report: who has no assigned ticket in specific statuses (e.g. Todo/In Progress)
const ENABLE_IDLE_REPORT = String(process.env.ENABLE_IDLE_REPORT || '').toLowerCase() !== 'false'; // default: true
const IDLE_REPORT_DISCORD_USER_ID =
    process.env.IDLE_REPORT_DISCORD_USER_ID || process.env.REPORT_DISCORD_USER_ID || process.env.ADMIN_DISCORD_USER_ID;
const IDLE_REPORT_CHANNEL_ID = process.env.IDLE_REPORT_CHANNEL_ID || process.env.REPORT_CHANNEL_ID;
const IDLE_REPORT_CRON = process.env.IDLE_REPORT_CRON || '5 9 * * *'; // default: daily 9:05
const IDLE_STATUS_NAMES = (process.env.IDLE_STATUS_NAMES || 'Todo,In Progress')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
const IDLE_STATUS_FIELD_NAME = (process.env.IDLE_STATUS_FIELD_NAME || '').trim(); // optional: exact field name (e.g. "Status")

const ENABLE_RR_MONITORING = String(process.env.ENABLE_RR_MONITORING || '').toLowerCase() !== 'false';
const RR_STATUS_NAMES = parseCommaList(process.env.RR_STATUS_NAMES, 'In Progress');
const RR_FIELD_NAME = String(process.env.RR_FIELD_NAME || 'Revisions Requested').trim();
const RR_YES_VALUES = parseCommaList(process.env.RR_YES_VALUES, 'Yes');
const RR_STATUS_FIELD_NAME = String(process.env.RR_STATUS_FIELD_NAME || '').trim(); // optional exact field name (e.g. "Status")
const RR_CHECK_CRON = process.env.RR_CHECK_CRON || '0 9 * * *';
const RR_CHANNEL_ID = process.env.RR_CHANNEL_ID || process.env.REVISIONS_CHANNEL_ID;
const PING_ON_REVISIONS = String(process.env.PING_ON_REVISIONS || '').toLowerCase() !== 'false';
const SUPPRESS_INITIAL_RR_NOTIFICATIONS =
    String(process.env.SUPPRESS_INITIAL_RR_NOTIFICATIONS || '').toLowerCase() !== 'false';

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

const RR_STORAGE_FILE = path.join(__dirname, 'rr-state.json');
let previousRRByUrl = new Map();
let hasLoadedRRState = false;

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

function loadRRState() {
    try {
        if (!fs.existsSync(RR_STORAGE_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(RR_STORAGE_FILE, 'utf8'));
        // Supported shapes:
        // - { "<issueUrl>": true/false, ... } (current; stores last-seen effective RR state)
        // - [ "<issueUrl>", ... ]             (legacy; treated as "RR=true")
        // - { "<issueUrl>": <number>, ... }   (older legacy; ignored so we can re-baseline)
        const next = new Map();
        if (Array.isArray(raw)) {
            // Legacy format: treat as "RR=true" for that URL.
            for (const url of raw) next.set(String(url), true);
        } else if (raw && typeof raw === 'object') {
            // If this looks like the old "comment id" map, ignore it and re-baseline.
            const values = Object.values(raw);
            const looksLikeOld = values.length > 0 && values.every(v => typeof v === 'number');
            if (looksLikeOld) {
                previousRRByUrl = new Map();
                hasLoadedRRState = false;
                console.log('Legacy rr-state.json detected (comment-id format). Will re-baseline RR state.');
                return;
            }
            for (const [url, value] of Object.entries(raw)) {
                // Some older versions used -1 as a sentinel meaning "already notified";
                // for transition-based tracking, treat it as last-seen true.
                if (value === -1) {
                    next.set(String(url), true);
                    continue;
                }
                next.set(String(url), Boolean(value));
            }
        }
        previousRRByUrl = next;
        hasLoadedRRState = true;
        console.log('Loaded previous RR state');
    } catch (error) {
        console.error('Error loading RR state:', error);
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

function saveRRState() {
    try {
        const obj = Object.fromEntries(previousRRByUrl);
        fs.writeFileSync(RR_STORAGE_FILE, JSON.stringify(obj, null, 2));
    } catch (error) {
        console.error('Error saving RR state:', error);
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
            items(first: 100, after: $after) {
                pageInfo {
                    hasNextPage
                    endCursor
                }
                nodes {
                    id
                    fieldValues(first: 50) {
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
                            __typename
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
                                owner {
                                    login
                                }
                            }
                        }
                        ... on PullRequest {
                            __typename
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
                                owner {
                                    login
                                }
                            }
                        }
                        ... on DraftIssue {
                            __typename
                            title
                        }
                    }
                }
            }
        }
    `;

    async function fetchAllPages(ownerType) {
        const maxPages = parseInt(process.env.PROJECT_ITEMS_MAX_PAGES || '50', 10); // 50 * 100 = 5000 items safety cap
        const results = [];
        let after = null;

        for (let page = 1; page <= maxPages; page++) {
            const baseQuery =
                ownerType === 'org'
                    ? `
                query($login: String!, $number: Int!, $after: String) {
                    organization(login: $login) {
                        ${queryBody}
                    }
                }
                `
                    : `
                query($login: String!, $number: Int!, $after: String) {
                    user(login: $login) {
                        ${queryBody}
                    }
                }
                `;

            const project = await octokit.graphql(baseQuery, { login: GITHUB_OWNER, number, after });
            const container =
                ownerType === 'org' ? project?.organization?.projectV2 : project?.user?.projectV2;

            const nodes = container?.items?.nodes || [];
            results.push(...nodes);

            const pageInfo = container?.items?.pageInfo;
            if (!pageInfo?.hasNextPage) break;
            after = pageInfo.endCursor;
            if (!after) break;
        }

        return results;
    }

    // Try organization-owned project first
    try {
        return await fetchAllPages('org');
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
        return await fetchAllPages('user');
    } catch (error) {
        console.error('Error fetching user project items:', error);
        return [];
    }
}

function getDeadlineFromItem(item) {
    const nodes = item?.fieldValues?.nodes || [];

    // GitHub Projects V2: the ticket "due date" is usually represented by a date field value.
    // We match common field names. (Your project uses "End date".)
    for (const node of nodes) {
        const fieldName = String(node?.field?.name || '').trim().toLowerCase();
        if (!fieldName) continue;

        const isDeadlineField =
            fieldName.includes('deadline') ||
            fieldName.includes('due date') ||
            fieldName.includes('end date') ||
            fieldName === 'date';

        if (!isDeadlineField) continue;
        if (!node?.date) continue;

        return new Date(node.date);
    }

    return null;
}

function normalizeStatusName(name) {
    return String(name || '').trim().toLowerCase();
}

function getStatusFromItem(item, preferredFieldNameRaw = '') {
    // Returns { fieldName, valueName } or null
    const singleSelectFields = (item?.fieldValues?.nodes || []).filter(
        node => node?.field?.name && typeof node?.name === 'string'
    );

    const desiredFieldName = preferredFieldNameRaw ? normalizeStatusName(preferredFieldNameRaw) : '';

    // Prefer explicit configured field name
    if (desiredFieldName) {
        const match = singleSelectFields.find(n => normalizeStatusName(n.field.name) === desiredFieldName);
        if (match) return { fieldName: match.field.name, valueName: match.name };
    }

    // Otherwise, best-effort: find a field that looks like a Status/Column
    const fallback = singleSelectFields.find(n => {
        const field = normalizeStatusName(n.field.name);
        return field.includes('status') || field.includes('column');
    });
    if (fallback) return { fieldName: fallback.field.name, valueName: fallback.name };

    return null;
}

function getSingleSelectValueByFieldName(item, desiredFieldName) {
    const singleSelectFields = (item?.fieldValues?.nodes || []).filter(
        node => node?.field?.name && typeof node?.name === 'string'
    );
    const want = normalizeStatusName(desiredFieldName);
    if (!want) return null;
    const match = singleSelectFields.find(n => normalizeStatusName(n.field.name) === want);
    if (!match) return null;
    return { fieldName: match.field.name, valueName: match.name };
}

function matchesAnyValue(valueName, allowedNames) {
    const v = normalizeStatusName(valueName);
    for (const raw of allowedNames || []) {
        const a = normalizeStatusName(raw);
        if (!a) continue;
        if (v === a || v.startsWith(`${a} `)) return true;
    }
    return false;
}

function tokenizeAlphaNumLower(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .filter(Boolean);
}

// tokenizeAlphaNumLower intentionally left in place (used elsewhere / handy for future).

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

function getAllKnownDevelopers() {
    const all = new Set();
    for (const k of devChannelMappings.keys()) all.add(k);
    for (const k of userMappings.keys()) all.add(k);
    return Array.from(all).sort((a, b) => a.localeCompare(b));
}

async function sendIdleDevelopersReport(context = {}) {
    if (!ENABLE_IDLE_REPORT) return;

    const idleDebug = String(process.env.IDLE_DEBUG || '').toLowerCase() === 'true';
    const source = String(context?.source || 'unknown');
    const startedAt = Date.now();

    try {
        console.log(
            `[idle] run start (source=${source}) statuses="${IDLE_STATUS_NAMES.join(', ')}" statusField="${
                IDLE_STATUS_FIELD_NAME || '(auto)'
            }"`
        );

        const items = await getProjectItems();
        console.log(`[idle] fetched project items=${items.length} (${Date.now() - startedAt}ms elapsed)`);

        const targetStatuses = new Set(IDLE_STATUS_NAMES.map(normalizeStatusName));
        const activeAssignees = new Set();

        for (const item of items) {
            if (!item?.content) continue;

            const status = getStatusFromItem(item, IDLE_STATUS_FIELD_NAME);
            if (!status) continue;

            if (!targetStatuses.has(normalizeStatusName(status.valueName))) continue;

            const assignees = item.content.assignees?.nodes || [];
            for (const a of assignees) {
                if (a?.login) activeAssignees.add(a.login);
            }
        }

        const developers = getAllKnownDevelopers();
        const idle = developers.filter(login => !activeAssignees.has(login));

        if (idleDebug) {
            console.log('[idle] debug snapshot:', {
                knownDevelopers: developers.length,
                activeAssignees: activeAssignees.size,
                idleCount: idle.length,
                activeAssigneesSample: Array.from(activeAssignees).sort().slice(0, 25)
            });
        }

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('📋 Daily idle devs report')
            .addFields(
                { name: 'Statuses checked', value: IDLE_STATUS_NAMES.join(', '), inline: false },
                { name: 'Known devs', value: String(developers.length), inline: true },
                { name: 'Active (has ticket)', value: String(activeAssignees.size), inline: true },
                { name: 'Idle (no ticket)', value: String(idle.length), inline: true }
            )
            .setTimestamp();

        if (idle.length > 0) {
            embed.addFields({
                name: 'Idle devs (GitHub logins)',
                value: idle.map(u => `- ${u}`).join('\n').slice(0, 1024) // Discord field limit safety
            });
        } else {
            embed.addFields({ name: 'Idle devs (GitHub logins)', value: 'None 🎉' });
        }

        const payload = { embeds: [embed] };

        if (IDLE_REPORT_CHANNEL_ID) {
            console.log(`[idle] sending report -> channel:${String(IDLE_REPORT_CHANNEL_ID)}`);
            await sendToTarget({ type: 'channel', id: String(IDLE_REPORT_CHANNEL_ID) }, payload);
            console.log(`[idle] run ok (${Date.now() - startedAt}ms total)`);
            return;
        }
        if (IDLE_REPORT_DISCORD_USER_ID) {
            console.log(`[idle] sending report -> dm:${String(IDLE_REPORT_DISCORD_USER_ID)}`);
            await sendToTarget({ type: 'dm', userId: String(IDLE_REPORT_DISCORD_USER_ID) }, payload);
            console.log(`[idle] run ok (${Date.now() - startedAt}ms total)`);
            return;
        }
        if (DEFAULT_CHANNEL_ID) {
            console.log(`[idle] sending report -> channel:${String(DEFAULT_CHANNEL_ID)} (default)`);
            await sendToTarget({ type: 'channel', id: String(DEFAULT_CHANNEL_ID) }, payload);
            console.log(`[idle] run ok (${Date.now() - startedAt}ms total)`);
            return;
        }

        console.log('Idle report enabled, but no report recipient configured (set IDLE_REPORT_* or DISCORD_CHANNEL_ID).');
        console.log(`[idle] run ended (no recipient) (${Date.now() - startedAt}ms total)`);
    } catch (error) {
        console.error(`[idle] run failed (source=${source})`, error);
        throw error;
    }
}

async function checkRevisionsRequested() {
    if (!ENABLE_RR_MONITORING) return;
    console.log('Checking for revisions requested (RR)...');

    const items = await getProjectItems();
    const targetStatuses = new Set(RR_STATUS_NAMES.map(normalizeStatusName));
    const rrMatches = [];
    const rrDebug = String(process.env.RR_DEBUG || '').toLowerCase() === 'true';
    let total = 0;
    let scanned = 0;
    const currentEffectiveRRByUrl = new Map();

    for (const item of items) {
        total++;

        // Prefer the canonical Issue/PR URL as the stable key; otherwise fall back to the project item id.
        const url = item?.content?.url ? String(item.content.url) : '';
        const key = url || `projectItem:${String(item?.id || '')}`;
        if (!key || key === 'projectItem:') continue;
        scanned++;

        const status = getStatusFromItem(item, RR_STATUS_FIELD_NAME);
        const isInTargetStatus =
            targetStatuses.size === 0 ||
            (status && targetStatuses.has(normalizeStatusName(status.valueName)));

        const rrField = getSingleSelectValueByFieldName(item, RR_FIELD_NAME);
        const isRRYes = rrField ? matchesAnyValue(rrField.valueName, RR_YES_VALUES) : false;

        // "Effective RR" means: item is in a target status AND RR field is set to a "yes" value.
        const effectiveRR = Boolean(isInTargetStatus && isRRYes);
        currentEffectiveRRByUrl.set(key, effectiveRR);

        // Always notify for all matching RR items on every run.
        if (effectiveRR) {
            rrMatches.push({ item, status, rrField });
        }
    }

    for (const { item, status, rrField } of rrMatches) {
        await sendRevisionsRequestedNotification(item, status, rrField);
    }

    // Persist last scan (useful for debugging / future transition logic).
    previousRRByUrl = currentEffectiveRRByUrl;
    saveRRState();
    hasLoadedRRState = true;

    console.log(`Found ${rrMatches.length} RR items (reported every run)`);
    if (rrDebug) {
        console.log('RR debug:', {
            fetchedItems: items.length,
            consideredItems: total,
            scanned,
            rrCount: rrMatches.length,
            statusFieldName: RR_STATUS_FIELD_NAME || '(auto)',
            rrFieldName: RR_FIELD_NAME,
            rrYesValues: RR_YES_VALUES,
            rrStatuses: RR_STATUS_NAMES
        });
    }
}

async function checkDeadlinesAndNotify() {
    console.log('Checking for upcoming deadlines...');
    
    const items = await getProjectItems();
    const todayItems = [];
    const tomorrowItems = [];
    const excludedStatuses = new Set(DEADLINE_EXCLUDE_STATUS_NAMES.map(normalizeStatusName));

    items.forEach(item => {
        if (!item.content) return;

        // Skip "Done" (or other excluded) statuses/columns
        if (excludedStatuses.size > 0) {
            const status = getStatusFromItem(item);
            if (status) {
                const value = normalizeStatusName(status.valueName);
                // exact match OR prefix match (handles e.g. "Done ✅")
                for (const ex of excludedStatuses) {
                    if (value === ex || value.startsWith(`${ex} `)) return;
                }
            }
        }

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

async function sendRevisionsRequestedNotification(item, status, rrField) {
    const content = item?.content || {};
    const assignees = content.assignees?.nodes || [];
    const assigneeLogins = assignees.map(a => a.login).filter(Boolean);
    const targets = getTargetsForGithubLogins(assigneeLogins);

    const fallbackTargets = [];
    if (targets.length === 0) {
        if (RR_CHANNEL_ID) fallbackTargets.push({ type: 'channel', id: String(RR_CHANNEL_ID) });
        else if (DEFAULT_CHANNEL_ID) fallbackTargets.push({ type: 'channel', id: String(DEFAULT_CHANNEL_ID) });
    }

    const mentionText = PING_ON_REVISIONS ? getMentionsForGithubLogins(assigneeLogins) : '';
    const contentText = mentionText ? `${mentionText} 🔄 Revisions requested` : '🔄 Revisions requested';

    const safeTitle = content?.title ? String(content.title) : `Project item ${String(item?.id || '')}`.trim();
    const safeUrl = content?.url ? String(content.url) : '';
    const safeRepo = content?.repository?.name ? String(content.repository.name) : 'Unknown';
    const safeNumber = typeof content?.number === 'number' ? `#${content.number}` : 'N/A';
    const safeType = content?.__typename ? String(content.__typename) : 'Unknown';

    const embed = new EmbedBuilder()
        .setColor('#b57edc')
        .setTitle(`🔄 Revisions Requested: ${safeTitle}`)
        .addFields(
            { name: 'Type', value: safeType, inline: true },
            { name: 'Repository', value: safeRepo, inline: true },
            { name: 'Issue/PR', value: safeNumber, inline: true },
            { name: 'Status', value: status?.valueName ? String(status.valueName) : 'Unknown', inline: true }
        )
        .setTimestamp();

    if (safeUrl) embed.setURL(safeUrl);

    embed.addFields({
        name: rrField?.fieldName ? rrField.fieldName : 'Revisions Requested',
        value: rrField?.valueName ? String(rrField.valueName) : 'Yes',
        inline: false
    });

    if (assigneeLogins.length > 0) {
        embed.addFields({ name: 'Assignees', value: assigneeLogins.map(a => `@${a}`).join(', ') });
    }

    const payload = { content: contentText || undefined, embeds: [embed] };
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
    // Load previous RR state
    loadRRState();
    
    // Avoid "redeploy spam" by default: rely on scheduled cron checks.
    // Opt-in if you want a run immediately at startup.
    if (RUN_ON_STARTUP) {
        checkDeadlinesAndNotify();
        checkNewAssignments();
        checkRevisionsRequested();
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

// Check for revisions requested (RR) periodically
if (ENABLE_RR_MONITORING) {
    cron.schedule(RR_CHECK_CRON, () => {
        checkRevisionsRequested();
    });
}

// Daily idle dev report (who has no assigned ticket in Todo/In Progress)
if (ENABLE_IDLE_REPORT) {
    cron.schedule(IDLE_REPORT_CRON, () => {
        sendIdleDevelopersReport({ source: 'cron' }).catch(err => {
            console.error('[idle] cron invocation failed', err);
        });
    });
}

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

    if (message.content === '!check-idle' && message.member.permissions.has('Administrator')) {
        await message.reply('Checking for idle devs...');
        try {
            await sendIdleDevelopersReport({ source: 'manual' });
        } catch (error) {
            // Keep the error user-friendly in Discord, but log full details to stdout/stderr.
            const msg = error?.message ? String(error.message) : 'Unknown error';
            await message.reply(`Idle report failed. Check bot logs. (${msg})`);
        }
    }

    if (message.content === '!check-rr' && message.member.permissions.has('Administrator')) {
        await message.reply('Checking for revisions requested (RR)...');
        await checkRevisionsRequested();
    }

    // Quick broadcast command: posts into the channel you typed it in
    // Usage:
    // - !revisions-requested
    // - !revisions-requested <optional extra context>
    if (message.content.startsWith('!revisions-requested') && message.member.permissions.has('Administrator')) {
        const extra = message.content.replace('!revisions-requested', '').trim();
        const text = extra ? `🔄 Revisions are requested! ${extra}` : '🔄 Revisions are requested!';
        await message.channel.send(text);
    }
});

// Login to Discord
discord.login(DISCORD_TOKEN);