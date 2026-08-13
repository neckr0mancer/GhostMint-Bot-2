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
function verifyDiscordContext(interaction,allowedGuildId) {
  if (!interaction?.user?.id || interaction.user.bot) throw new BotContextError('Discord sender is missing or is a bot');
  if (allowedGuildId&&(!interaction.guildId || !interaction.channelId || String(interaction.guildId)!==String(allowedGuildId))) {
    throw new BotContextError('Discord command came from an unauthorized guild or channel');
  }
  return {platformUserId:String(interaction.user.id),contextId:`${interaction.guildId}:${interaction.channelId}`};
}
function createCommandRateLimiter({now=()=>Date.now(),limit=3,windowMs=30_000}={}) {
  const buckets=new Map();
  return {check(platform,userId,command) {
    const key=`${platform}:${userId}:${command}`, timestamp=now();
    const recent=(buckets.get(key)||[]).filter(value=>timestamp-value<windowMs);
    if(recent.length>=limit) throw new RateLimitError(windowMs-(timestamp-recent[0]));
    recent.push(timestamp);buckets.set(key,recent);
  }};
}
module.exports={BotContextError,RateLimitError,commandName,createCommandRateLimiter,escapeDiscord,escapeTelegram,
  requireTextConfirmation,verifyDiscordContext,verifyTelegramContext};
