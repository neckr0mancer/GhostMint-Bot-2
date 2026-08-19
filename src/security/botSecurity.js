const DISCORD_MARKDOWN=/([\\`*_{}\[\]()<>#+\-.!|~])/g;
const TELEGRAM_MARKDOWN=/([\\_*\[\]()`])/g;

class BotContextError extends Error {
  constructor(message) { super(message); this.name='BotContextError'; }
}
class RateLimitError extends Error {
  constructor(retryAfterMs) { super('Sensitive command rate limit exceeded'); this.name='RateLimitError'; this.retryAfterMs=retryAfterMs; }
}

function escapeDiscord(value) { return String(value??'').replace(DISCORD_MARKDOWN,'\\$1').replaceAll('@','@\u200b'); }
function escapeTelegram(value) { return String(value??'').replace(TELEGRAM_MARKDOWN,'\\$1'); }
// Telegram's HTML parse mode (the mode every bot message now uses -- see src/server.js's tg*
// primitives) only requires escaping these three characters; anything else (including literal
// asterisks/underscores/backticks, which HTML mode does not treat as markup) passes through as-is.
// Used wherever free-text a user supplied (wallet label, task name, watch-rule name) is interpolated
// into a message alongside real <b>/<code> tags, so it can never break out of or corrupt those tags.
function escapeTelegramHtml(value) { return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function commandName(value) { return String(value||'unknown').trim().split(/\s+/)[0].replace(/^\//,'').split('@')[0].toLowerCase().slice(0,64)||'unknown'; }
function requireTextConfirmation(value) {
  if(value!=='CONFIRM')throw new BotContextError('Destructive or value-moving command requires exact CONFIRM');
}

function verifyTelegramContext(message) {
  if (!message?.from?.id || message.from.is_bot) throw new BotContextError('Telegram sender is missing or is a bot');
  if (!message.chat?.id || message.chat.type!=='private' || String(message.chat.id)!==String(message.from.id)) {
    throw new BotContextError('Telegram commands are accepted only in the sender private chat');
  }
  return {platformUserId:String(message.from.id),contextId:String(message.chat.id)};
}
// allowedChannelIds narrows the bot to specific channels without pinning it to one guild the way
// allowedGuildId does -- the two are independent and compose. A DM has no guildId and is never
// filtered by either: it is already a private, one-to-one surface, and it is where a wallet bot is
// safest to use, so restricting public channels must not take it away.
function verifyDiscordContext(interaction,allowedGuildId,{allowedChannelIds=null}={}) {
  if (!interaction?.user?.id || interaction.user.bot) throw new BotContextError('Discord sender is missing or is a bot');
  if (allowedGuildId&&(!interaction.guildId || !interaction.channelId || String(interaction.guildId)!==String(allowedGuildId))) {
    throw new BotContextError('Discord command came from an unauthorized guild or channel');
  }
  if (allowedChannelIds&&allowedChannelIds.length&&interaction.guildId
    &&!allowedChannelIds.map(String).includes(String(interaction.channelId))) {
    throw new BotContextError('Discord command came from a channel this bot is not enabled in');
  }
  return {platformUserId:String(interaction.user.id),contextId:`${interaction.guildId}:${interaction.channelId}`};
}
function createCommandRateLimiter({now=()=>Date.now(),limit=3,windowMs=30_000,sweepThreshold=10_000}={}) {
  const buckets=new Map();
  // A key (one per distinct platform:userId:command ever seen) never gets removed just from being
  // checked -- the entry being updated always ends up non-empty right after the push below, so a
  // bucket only goes stale when that exact command stops being called, which check() alone can never
  // detect for its OWN key. Without this, a long-running bot accumulates one entry per unique command
  // ever tried by every user, forever. Sweeping only when the map has grown large keeps the common
  // case free of extra work instead of paying an O(n) scan on every single call.
  function sweep(timestamp) {
    for (const [key, values] of buckets) {
      const recent=values.filter(value=>timestamp-value<windowMs);
      if (recent.length) buckets.set(key,recent); else buckets.delete(key);
    }
  }
  return {check(platform,userId,command) {
    const key=`${platform}:${userId}:${command}`, timestamp=now();
    if (buckets.size>=sweepThreshold) sweep(timestamp);
    const recent=(buckets.get(key)||[]).filter(value=>timestamp-value<windowMs);
    if(recent.length>=limit) throw new RateLimitError(windowMs-(timestamp-recent[0]));
    recent.push(timestamp);buckets.set(key,recent);
  }};
}
module.exports={BotContextError,RateLimitError,commandName,createCommandRateLimiter,escapeDiscord,escapeTelegram,escapeTelegramHtml,
  requireTextConfirmation,verifyDiscordContext,verifyTelegramContext};
