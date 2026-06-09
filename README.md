# GitHub Project Discord Notifier Bot

A Discord bot that monitors your GitHub Project Management board and sends notifications to Discord when tickets have deadlines approaching (today or tomorrow).

## Features

- 🔔 Automatic notifications for tickets due today (red alert)
- 📅 Automatic notifications for tickets due tomorrow (orange warning)
- 👥 Notifies the assigned dev(s) in their own Discord channel (or DM fallback)
- 🧭 Optional default/fallback channel support
- 🧠 Baseline state so “new assignments” only notify going forward (no historic spam)
- 🚀 No redeploy pings by default (startup checks are opt-in)
- 🧑‍💻 Daily “idle devs” report (who has no assigned ticket in Todo/In Progress)
- 🔄 “Revisions Requested” monitor (e.g. items in “In Progress” with a comment containing a code like `/RR`)
- ⏰ Scheduled daily checks (default: 9 AM)
- 🔧 Manual trigger command for administrators
- 📊 Works with GitHub Projects V2

## Prerequisites

1. Node.js (v16 or higher)
2. A Discord bot token
3. A GitHub Personal Access Token with project permissions
4. A GitHub organization with a Project board

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Create Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Go to the "Bot" section
4. Click "Add Bot"
5. Under "Privileged Gateway Intents", enable:
   - Server Members Intent
   - Message Content Intent
6. Copy the bot token
7. Go to OAuth2 → URL Generator
8. Select scopes: `bot`
9. Select permissions: `Send Messages`, `Embed Links`, `Mention Everyone`
10. Use the generated URL to invite the bot to your server

### 3. Get Discord Channel ID

1. Enable Developer Mode in Discord (User Settings → Advanced → Developer Mode)
2. Right-click the channel where you want notifications
3. Click "Copy ID"

### 4. Create GitHub Personal Access Token

1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click "Generate new token (classic)"
3. Give it a name and select scopes:
   - `repo` (Full control of private repositories)
   - `read:org` (Read organization data)
   - `project` (Full control of projects)
4. Generate and copy the token

### 5. Find Your Project Number

The project number is in the URL of your GitHub Project:
`https://github.com/orgs/YOUR_ORG/projects/NUMBER`

### 6. Configure Environment Variables

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and fill in your values:
   ```env
   DISCORD_TOKEN=your_discord_bot_token
   # Optional fallback channel (used only when needed)
   DISCORD_CHANNEL_ID=your_channel_id
   GITHUB_TOKEN=your_github_token
   # IMPORTANT: this is the GitHub *login/slug* (the part in the URL), not the display name
   # Examples:
   # - Org project: https://github.com/orgs/ComfortDevInnov/projects/1  -> GITHUB_ORG=ComfortDevInnov
   # - User project: https://github.com/users/<your_login>/projects/1   -> GITHUB_ORG=<your_login>
   GITHUB_ORG=your_org_or_user_login
   PROJECT_NUMBER=1
   # GitHub login -> Discord user ID (for mentions + DM fallback)
   USER_MAPPINGS={"github_user": "discord_user_id"}
   # GitHub login -> Discord channel ID (send notices to each dev’s own channel)
   DEV_CHANNEL_MAPPINGS={"github_user":"123456789012345678","another_user":"234567890123456789"}

   # Behavior toggles
   # Prevent redeploy/startup spam by default: rely on cron schedules.
   RUN_ON_STARTUP=false
   # On first-ever run (no state file), record a baseline and don't notify old assignments.
   SUPPRESS_INITIAL_ASSIGNMENT_NOTIFICATIONS=true
   # Control pings (mentions) independently
   PING_ON_ASSIGNMENTS=true
   PING_ON_DEADLINES=true
   # If an item has no assignees (or no mappings), optionally notify in the default channel
   NOTIFY_UNASSIGNED_DEADLINES_TO_DEFAULT_CHANNEL=false
   # Exclude statuses/columns from deadline checks (comma-separated). Default is "Done".
   DEADLINE_EXCLUDE_STATUS_NAMES="Done"

   # Daily idle devs report (who has no assigned ticket in Todo/In Progress)
   ENABLE_IDLE_REPORT=true
   # Where to send the report (prefer channel; DM is fallback)
   IDLE_REPORT_CHANNEL_ID=123456789012345678
   IDLE_REPORT_DISCORD_USER_ID=123456789012345678
   # Schedule (cron); default is daily at 9:05
   IDLE_REPORT_CRON="5 9 * * *"
   # Status values to treat as “active work”; defaults to "Todo,In Progress"
   IDLE_STATUS_NAMES="Todo,In Progress"
   # Optional: force which project field is used (e.g. "Status")
   IDLE_STATUS_FIELD_NAME="Status"

   # Revisions Requested (RR) monitoring
   # Issues (tickets) only: when an item is in one of these statuses AND has a single-select field "Revisions Requested" set to "Yes", notify once.
   ENABLE_RR_MONITORING=true
   RR_STATUS_NAMES="In Progress"
   RR_FIELD_NAME="Revisions Requested"
   RR_YES_VALUES="Yes"
   # How often to scan (cron); default in code is daily at 9:00
   RR_CHECK_CRON="0 9 * * *"
   # Optional: if the assignees have no routing mappings, post RR notices here (otherwise falls back to DISCORD_CHANNEL_ID)
   RR_CHANNEL_ID=123456789012345678
   PING_ON_REVISIONS=true
   # On first-ever run (no rr-state.json), record a baseline and don't notify existing RR items.
   SUPPRESS_INITIAL_RR_NOTIFICATIONS=true
   ```

### 7. Map GitHub Users to Discord Users

To ping Discord users, you need to map GitHub usernames to Discord user IDs:

1. Get Discord User IDs:
   - Enable Developer Mode in Discord
   - Right-click a user and select "Copy ID"

2. Update USER_MAPPINGS in `.env`:
   ```json
   {"github_username": "discord_user_id", "another_user": "123456789"}
   ```

### 8. Route each dev to their own channel

If you want notifications to go to a specific channel per dev (recommended), set `DEV_CHANNEL_MAPPINGS`:

```json
{"github_username":"123456789012345678","another_user":"234567890123456789"}
```

If a dev has no channel mapping but does have a `USER_MAPPINGS` entry, the bot will DM them instead.

## Running the Bot

### Development Mode (with auto-restart)
```bash
npm run dev
```

### Production Mode
```bash
npm start
```

## Usage

### Automatic Checks
The bot automatically checks for deadlines every day at 9 AM (configurable in the code).

### Manual Check
Administrators can trigger a manual check by sending this command in any channel:
```
!check-deadlines
```
And:
```
!check-assignments
```
And:
```
!check-idle
```
And:
```
!check-rr
```

## Customization

### Change Check Schedule

Edit the cron schedule in `github-discord-bot.js`:

```javascript
// Current: Every day at 9 AM
cron.schedule('0 9 * * *', () => {
    checkDeadlinesAndNotify();
});

// Examples:
// Every hour: '0 * * * *'
// Every day at 2 PM: '0 14 * * *'
// Twice a day (9 AM and 5 PM): '0 9,17 * * *'
```

### Customize Deadline Field Name

The bot looks for fields named "Deadline", "Due Date", "End date", or "Date". To customize, edit this section:

```javascript
node.field.name.toLowerCase().includes('deadline') ||
node.field.name.toLowerCase().includes('due date') ||
node.field.name.toLowerCase().includes('end date') ||
node.field.name.toLowerCase() === 'date'
```

### Change Notification Colors

Edit the color codes in the notification calls:

```javascript
await sendDeadlineNotification(item, 'TODAY', '#ff0000'); // Red for today
await sendDeadlineNotification(item, 'TOMORROW', '#ffa500'); // Orange for tomorrow
```

## Notification Format

The bot sends embedded messages with:
- Title with deadline urgency (TODAY/TOMORROW)
- Link to the GitHub issue/PR
- Repository name
- Issue/PR number
- Deadline date
- List of assignees
- Mentions for mapped Discord users

## Troubleshooting

### Bot doesn't send notifications
- Verify the bot has permissions in the channel
- Check that DISCORD_CHANNEL_ID is correct
- Ensure the bot is online and running

### GitHub API errors
- Verify your GITHUB_TOKEN has the correct permissions
- Check that PROJECT_NUMBER and GITHUB_ORG are correct
- Ensure your organization uses GitHub Projects V2

### Users not getting pinged
- Verify USER_MAPPINGS is valid JSON
- Check that Discord user IDs are correct
- Ensure GitHub usernames match exactly

### It pings everyone after redeploy
- Keep `RUN_ON_STARTUP=false` (default) so it waits for scheduled cron checks
- Keep `SUPPRESS_INITIAL_ASSIGNMENT_NOTIFICATIONS=true` so the first run creates a baseline state
- Important: `assignment-state.json` is stored locally; if your hosting is ephemeral, mount a persistent volume so redeploys keep the state

## Project Structure

```
.
├── github-discord-bot.js   # Main bot code
├── package.json            # Dependencies
├── .env                    # Configuration (create this)
├── .env.example           # Configuration template
└── README.md              # This file
```

## Dependencies

- `discord.js` - Discord API wrapper
- `@octokit/rest` - GitHub API wrapper
- `node-cron` - Task scheduler
- `dotenv` - Environment variable loader

## License

MIT

## Contributing

Feel free to open issues or submit pull requests for improvements!