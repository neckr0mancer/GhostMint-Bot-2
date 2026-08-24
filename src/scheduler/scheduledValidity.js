// Scheduled-mint validity oracle -- pure, provider-agnostic, no I/O. Answers one question for the
// pre-arm and drift paths: given what the chain says RIGHT NOW about a drop's window, when should
// this task actually fire?
//
// The advertised mint time is treated as imperfect information. The contract's own PublicDrop
// (SeaDrop) or OpenSea's stage data is authoritative; a wall-clock schedule is a guess that may be
// seconds off in either direction -- exactly the gap dedicated mint scripts exploit.
//
// Phase semantics (all times epoch ms; the chain reports seconds, callers convert):
//   'no-data' -- the oracle has nothing (no PublicDrop, unreadable) : fire as scheduled and let
//                executeTask's own checks decide; never invent a window.
//   'early'   -- now < startTime                                   : the competitive case. The task
//                should move its fire moment to startTime (bounded by the caller's re-arm window).
//   'open'    -- startTime <= now (and endTime not passed)          : fire now; drift check passes.
//   'late'    -- endTime set and now > endTime                      : the window is gone; executeTask
//                fails this permanently (SCHEDULE_DRIFT) -- re-arming would only chase a corpse.

function classifySeaDropWindow(livePublicDrop, nowMs) {
  if (!livePublicDrop || !Number.isFinite(Number(livePublicDrop.startTime))) {
    return { phase: 'no-data' };
  }
  const startTimeMs = Number(livePublicDrop.startTime) * 1000;
  const endTimeMs = Number.isFinite(Number(livePublicDrop.endTime)) && Number(livePublicDrop.endTime) > 0
    ? Number(livePublicDrop.endTime) * 1000
    : null;
  const nowSec = Math.floor(nowMs / 1000);
  // Same second-granularity comparison the drift preflight uses: a task claimed at
  // T+0.9s sees nowSec === T and is NOT early -- the floor is the contract's own clock.
  if (nowSec < Number(livePublicDrop.startTime)) return { phase: 'early', startTimeMs, endTimeMs };
  if (endTimeMs !== null && nowMs > endTimeMs) return { phase: 'late', startTimeMs, endTimeMs };
  return { phase: 'open', startTimeMs, endTimeMs };
}

// Should the pre-arm move this task's fire moment to the contract's real opening? Only when the
// window is genuinely early AND the correction stays inside the caller's re-arm window -- a drop
// that slipped by a day is a reschedule conversation, not a silent timer move. `scheduledMs` is
// what the user asked for; `rearmWindowMs` mirrors schedulerWorker's STAGE_REARM_WINDOW_MS.
function preArmRearm(classification, scheduledMs, rearmWindowMs) {
  if (!classification || classification.phase !== 'early') return null;
  const scheduled = Number.isFinite(scheduledMs) ? scheduledMs : 0;
  if (!Number.isFinite(classification.startTimeMs) || classification.startTimeMs <= 0) return null;
  if (classification.startTimeMs - scheduled > rearmWindowMs) return null;
  return { fireAtMs: classification.startTimeMs, reason: `live SeaDrop window opens ${new Date(classification.startTimeMs).toISOString()}, ${Math.round((classification.startTimeMs - scheduled) / 1000)}s after the scheduled time` };
}

module.exports = { classifySeaDropWindow, preArmRearm };
