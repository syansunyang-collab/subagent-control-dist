const replacements = [
  {
    label: "request byte count",
    baseline: "bodyJson=JSON.stringify(body),httpTimeoutMs=normalizeTimeoutMs(options?.timeoutMs)",
    patched: "bodyJson=JSON.stringify(body),requestBytes=new TextEncoder().encode(bodyJson).byteLength,httpTimeoutMs=normalizeTimeoutMs(options?.timeoutMs)",
  },
  {
    label: "recoverable websocket gate",
    baseline: "startEmitted=!1,websocketDisabledForSession=transport!==\"sse\"&&isWebSocketSseFallbackActive(cacheSessionId);",
    patched: "startEmitted=!1,websocketAttempt=transport===\"sse\"?{allowed:!1,recoveryProbe:!1}:acquireWebSocketAttempt(cacheSessionId,requestBytes),websocketDisabledForSession=transport!==\"sse\"&&!websocketAttempt.allowed;",
  },
  {
    label: "websocket success",
    baseline: "assertSuccessfulOutput(output),stream2.push({type:\"done\",reason:output.stopReason,message:output}),stream2.end();return}catch(error){",
    patched: "assertSuccessfulOutput(output),recordWebSocketSuccess(cacheSessionId,websocketAttempt.recoveryProbe),stream2.push({type:\"done\",reason:output.stopReason,message:output}),stream2.end();return}catch(error){",
  },
  {
    label: "websocket failure",
    baseline: "if(aborted||isCodexNonTransportError(error)&&!connectionLimitBeforeStart||(appendAssistantMessageDiagnostic(output,createAssistantMessageDiagnostic(\"provider_transport_failure\",error,{configuredTransport:transport,fallbackTransport:websocketStarted?void 0:\"sse\",eventsEmitted:websocketStarted,phase:websocketStarted?\"after_message_stream_start\":\"before_message_stream_start\",requestBytes:new TextEncoder().encode(bodyJson).byteLength})),recordWebSocketFailure(cacheSessionId,error),websocketStarted))throw error;",
    patched: "if(aborted){releaseWebSocketRecoveryProbe(cacheSessionId,websocketAttempt.recoveryProbe);throw error}if(isCodexNonTransportError(error)&&!connectionLimitBeforeStart){recordWebSocketSuccess(cacheSessionId,websocketAttempt.recoveryProbe);throw error}if(appendAssistantMessageDiagnostic(output,createAssistantMessageDiagnostic(\"provider_transport_failure\",error,{configuredTransport:transport,fallbackTransport:websocketStarted?void 0:\"sse\",eventsEmitted:websocketStarted,phase:websocketStarted?\"after_message_stream_start\":\"before_message_stream_start\",requestBytes})),recordWebSocketFailure(cacheSessionId,error,requestBytes),websocketStarted)throw error;",
    alternatives: [
      {
        baseline: "if(aborted||isCodexNonTransportError(error)&&!connectionLimitBeforeStart||(appendAssistantMessageDiagnostic(output,createAssistantMessageDiagnostic(\"provider_transport_failure\",error,{configuredTransport:transport,...websocketStarted?{}:{fallbackTransport:\"sse\"},eventsEmitted:websocketStarted,phase:websocketStarted?\"after_message_stream_start\":\"before_message_stream_start\",requestBytes:new TextEncoder().encode(bodyJson).byteLength})),recordWebSocketFailure(cacheSessionId,error),websocketStarted))throw error;",
        patched: "if(aborted){releaseWebSocketRecoveryProbe(cacheSessionId,websocketAttempt.recoveryProbe);throw error}if(isCodexNonTransportError(error)&&!connectionLimitBeforeStart){recordWebSocketSuccess(cacheSessionId,websocketAttempt.recoveryProbe);throw error}if(appendAssistantMessageDiagnostic(output,createAssistantMessageDiagnostic(\"provider_transport_failure\",error,{configuredTransport:transport,...websocketStarted?{}:{fallbackTransport:\"sse\"},eventsEmitted:websocketStarted,phase:websocketStarted?\"after_message_stream_start\":\"before_message_stream_start\",requestBytes})),recordWebSocketFailure(cacheSessionId,error,requestBytes),websocketStarted)throw error;",
      },
    ],
  },
  {
    label: "websocket idle ttl",
    baseline: "SESSION_WEBSOCKET_CACHE_TTL_MS=300*1e3",
    patched: "SESSION_WEBSOCKET_CACHE_TTL_MS=900*1e3",
  },
  {
    label: "shared recovery state",
    baseline: "SESSION_WEBSOCKET_MAX_AGE_MS=3300*1e3,websocketSessionCache=new Map,websocketDebugStats=new Map,websocketSseFallbackSessions=new Set;",
    patched: "SESSION_WEBSOCKET_MAX_AGE_MS=3300*1e3,WEBSOCKET_FALLBACK_INITIAL_COOLDOWN_MS=30*1e3,WEBSOCKET_FALLBACK_MAX_COOLDOWN_MS=300*1e3,WEBSOCKET_OVERSIZE_RECOVERY_RATIO=.8,globalWithOpenAICodexWebSocketRecoveryState=globalThis,websocketRecoveryState=globalWithOpenAICodexWebSocketRecoveryState.__piOpenAICodexWebSocketRecoveryState;websocketRecoveryState||(websocketRecoveryState={websocketDebugStats:new Map,websocketFallbackStates:new Map},globalWithOpenAICodexWebSocketRecoveryState.__piOpenAICodexWebSocketRecoveryState=websocketRecoveryState);var websocketSessionCache=new Map,{websocketDebugStats,websocketFallbackStates}=websocketRecoveryState;",
  },
  {
    label: "recovery stats",
    baseline: "websocketFailures:0,sseFallbacks:0}",
    patched: "websocketFailures:0,sseFallbacks:0,websocketRecoveryProbes:0,websocketRecoveries:0,oversizeFallbacks:0}",
  },
  {
    label: "reset one recovery state",
    baseline: "websocketSseFallbackSessions.delete(sessionId)",
    patched: "websocketFallbackStates.delete(sessionId)",
  },
  {
    label: "reset all recovery state",
    baseline: "websocketSseFallbackSessions.clear()",
    patched: "websocketFallbackStates.clear()",
  },
  {
    label: "recovery acquisition",
    baseline: "registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);function isWebSocketSseFallbackActive",
    patched: "registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);function acquireWebSocketAttempt(sessionId,requestBytes){if(!sessionId)return{allowed:!0,recoveryProbe:!1};let state=websocketFallbackStates.get(sessionId);if(!state)return{allowed:!0,recoveryProbe:!1};if(state.probeInFlight)return{allowed:!1,recoveryProbe:!1};if(state.reason===\"message_too_big\"&&state.failedRequestBytes!==void 0&&requestBytes>Math.floor(state.failedRequestBytes*WEBSOCKET_OVERSIZE_RECOVERY_RATIO))return{allowed:!1,recoveryProbe:!1};if(state.reason===\"transport\"&&Date.now()<state.retryAt)return{allowed:!1,recoveryProbe:!1};state.probeInFlight=!0;let stats=getOrCreateWebSocketDebugStats(sessionId);return stats.websocketRecoveryProbes++,{allowed:!0,recoveryProbe:!0}}function isWebSocketSseFallbackActive",
  },
  {
    label: "active recovery state",
    baseline: "return sessionId?websocketSseFallbackSessions.has(sessionId):!1",
    patched: "return sessionId?websocketFallbackStates.has(sessionId):!1",
  },
  {
    label: "recovery transitions",
    baseline: "function recordWebSocketFailure(sessionId,error){if(!sessionId)return;websocketSseFallbackSessions.add(sessionId);let stats=getOrCreateWebSocketDebugStats(sessionId);stats.websocketFailures++,stats.lastWebSocketError=formatThrownValue(error),stats.websocketFallbackActive=!0}",
    patched: "function isWebSocketMessageTooBigError(error){return error instanceof WebSocketCloseError&&error.code===WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE}function recordWebSocketFailure(sessionId,error,requestBytes){if(!sessionId)return;let reason=isWebSocketMessageTooBigError(error)?\"message_too_big\":\"transport\",previous=websocketFallbackStates.get(sessionId),consecutiveFailures=previous?.reason===reason?previous.consecutiveFailures+1:1,cooldownMs=Math.min(WEBSOCKET_FALLBACK_INITIAL_COOLDOWN_MS*2**(consecutiveFailures-1),WEBSOCKET_FALLBACK_MAX_COOLDOWN_MS),state={reason,consecutiveFailures,retryAt:reason===\"transport\"?Date.now()+cooldownMs:0,probeInFlight:!1,failedRequestBytes:reason===\"message_too_big\"?requestBytes:void 0};websocketFallbackStates.set(sessionId,state);let stats=getOrCreateWebSocketDebugStats(sessionId);stats.websocketFailures++,reason===\"message_too_big\"&&stats.oversizeFallbacks++,stats.lastWebSocketError=formatThrownValue(error),stats.websocketFallbackActive=!0,stats.fallbackReason=reason,stats.consecutiveFailures=consecutiveFailures,stats.nextProbeAt=reason===\"transport\"?state.retryAt:void 0,stats.lastFailedRequestBytes=state.failedRequestBytes}function releaseWebSocketRecoveryProbe(sessionId,recoveryProbe){if(!sessionId||!recoveryProbe)return;let state=websocketFallbackStates.get(sessionId);state&&(state.probeInFlight=!1)}function recordWebSocketSuccess(sessionId,recoveryProbe){if(!sessionId)return;let state=websocketFallbackStates.get(sessionId);if(!state)return;websocketFallbackStates.delete(sessionId);let stats=getOrCreateWebSocketDebugStats(sessionId);recoveryProbe&&stats.websocketRecoveries++,stats.websocketFallbackActive=!1,stats.fallbackReason=void 0,stats.consecutiveFailures=0,stats.nextProbeAt=void 0,stats.lastFailedRequestBytes=void 0}",
  },
];

function replaceExactly(source, from, to, label) {
  const first = source.indexOf(from);
  if (first === -1) throw new Error(`bundle transform: missing ${label}`);
  if (source.indexOf(from, first + from.length) !== -1) {
    throw new Error(`bundle transform: ${label} is not unique`);
  }
  return `${source.slice(0, first)}${to}${source.slice(first + from.length)}`;
}

function pairsFor(step, desiredState) {
  const variants = [{ baseline: step.baseline, patched: step.patched }, ...(step.alternatives ?? [])];
  return desiredState === "patched"
    ? variants
    : variants.map(({ baseline, patched }) => ({ baseline: patched, patched: baseline }));
}

function applyStep(source, step, desiredState) {
  const hits = pairsFor(step, desiredState).filter(({ baseline }) => source.includes(baseline));
  if (hits.length === 0) throw new Error(`bundle transform: missing ${step.label}`);
  if (hits.length > 1) throw new Error(`bundle transform: ${step.label} matched multiple layouts`);
  return replaceExactly(source, hits[0].baseline, hits[0].patched, step.label);
}

export function transformOpenAICodexBundle(source, desiredState) {
  if (desiredState !== "baseline" && desiredState !== "patched") {
    throw new Error(`bundle transform: unsupported state ${desiredState}`);
  }
  const steps = desiredState === "patched" ? replacements : [...replacements].reverse();
  return steps.reduce((current, step) => applyStep(current, step, desiredState), source);
}
