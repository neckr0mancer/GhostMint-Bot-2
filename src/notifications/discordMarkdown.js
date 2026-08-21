// Live-reported: a Discord DM read "❌ Scheduled mint <b>PUBLIC</b> failed." literally, tags and
// all. Every notifyUser message (src/server.js) is built once as Telegram HTML (escapeTelegramHtml
// + <b>/<code> markup) and handed to notificationService.sendToUser, which fans it out unchanged to
// every linked platform -- correct for Telegram (sent with parse_mode:'HTML'), but Discord has no
// HTML parser at all, so the raw tags show as text instead of formatting. Converts the small, fixed
// set of tags these messages actually use (grepped every notifyUser call site) into Discord
// markdown, then reverses escapeTelegramHtml's own entity-escaping (&amp;/&lt;/&gt;) -- those
// entities were only ever needed to keep dynamic content (task names, error text) safe inside
// Telegram's HTML parser, and Discord doesn't decode HTML entities either, so left alone they'd show
// as literal "&amp;" instead of "&". Order matters: tags convert first, entities decode second, so a
// task literally named "<b>" round-trips to displaying as literal "<b>" text on Discord, not a stray
// unmatched markdown delimiter.
function telegramHtmlToDiscordMarkdown(text) {
  return String(text ?? '')
    .replace(/<b>/g, '**').replace(/<\/b>/g, '**')
    .replace(/<code>/g, '`').replace(/<\/code>/g, '`')
    .replace(/<i>/g, '*').replace(/<\/i>/g, '*')
    .replace(/<pre>/g, '```').replace(/<\/pre>/g, '```')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

module.exports = { telegramHtmlToDiscordMarkdown };
