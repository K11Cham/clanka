# Clanka

A WhatsApp bot built with Node.js and the Baileys library. Provides group management features, media conversion tools, and entertainment commands.

## Features

### Group Management
- **Anti-Link**: Automatically detects and removes messages containing links (configurable per group)
- **Anti-Mention**: Automatically detects and removes messages with mentions (configurable per group)
- **Warning System**: Users receive warnings for violations; 3 warnings result in automatic removal
- **Mute/Unmute**: Temporarily mute groups with timed auto-unmute (supports minutes, hours, days)
- **Add Participants**: Add users to groups via phone number or mention

### Media Tools
- **Sticker to Image**: Convert WhatsApp stickers to PNG images
- **Image to Sticker**: Convert images to WhatsApp stickers (512x512, WebP format)

### Entertainment
- **Rock Paper Scissors**: Play RPS against the bot
- **Waifu Images**: Fetch random anime-style images (SFW only)
- **Auto-Type**: Simulate typing indicator for specified duration

### Utilities
- **Participants List**: View group participants
- **Admins List**: View group administrators
- **Ping**: Test bot responsiveness

## Installation

1. Clone the repository:
```bash
git clone https://github.com/K11Cham/clanka.git
cd clanka
```

2. Install dependencies:
```bash
npm install
```

3. Run the bot:
```bash
node index.js
```

4. Scan the QR code with WhatsApp to authenticate

## Commands

### Public Commands
- `!participants` - List group participants
- `!admins` - List group admins
- `!ping [message]` - Test bot (echoes message if provided)
- `!rps rock/paper/scissors` - Play rock paper scissors
- `!waifu` - Fetch random waifu image (SFW only)
- `!autotype [1-30]` - Show typing indicator for N seconds
- `!toimg` - Reply to a sticker to convert it to an image
- `!tosticker` - Reply to an image to convert it to a sticker
- `!add @user` or `!add 1555...` - Add user to group (bot must be admin)

### Admin-Only Commands
- `!mute [time]` - Mute group (e.g., `30`, `1h`, `2d`)
- `!unmute` - Unmute group

## Configuration

The bot automatically creates and manages the following files (excluded from git for security):

- `bot_db.json` - Stores warnings, antilink settings, superadmins, mutes, and antimention settings
- `known_groups.json` - Tracks groups the bot has joined
- `superadmin_db.json` - Stores superadmin configuration
- `auth_info_baileys/` - WhatsApp session authentication data

## Security Notes

- Session data (`auth_info_baileys/`) contains sensitive authentication credentials
- Database files contain user information and group settings
- These files are automatically excluded from version control via `.gitignore`
- Never commit these files to a public repository

## Dependencies

- `@whiskeysockets/baileys` - WhatsApp Web API implementation
- `@hapi/boom` - HTTP error handling
- `axios` - HTTP client for API requests
- `sharp` - Image processing
- `qrcode-terminal` - QR code generation for authentication
- `pin` - Process management

## License

ISC
