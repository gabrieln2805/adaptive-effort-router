import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { detectComplexity } from './lib/complexity.js';
import { route, checkFableRefusal, MODELS } from './lib/router.js';
import { ObservabilityTracker } from './lib/observability.js';

const app = express();
app.use(express.json({ limit: '25mb' }));

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env
const tracker = new ObservabilityTracker();

/**
 * POST /v1/messages
 *
 * Drop-in-ish replacement for the Anthropic Messages endpoint. Body is the
 * standard Messages API request shape, PLUS an optional top-level
 * `routing_hint: { blocking: boolean }` the caller can set to mark a
 * request as synchronous/user-blocking (as opposed to a background job that
 * can tolerate more iteration). If omitted, `blocking` defaults to true —
 * conservative default, since most direct API callers are waiting on the
 * response.
 *
 * Any temperature/top_p/top_k/thinking.budget_tokens fields in the incoming
 * body are stripped before forwarding — see stripLegacySamplingParams()
 * below. Callers migrating old integrations through this proxy don't need
 * to touch their call sites first; the proxy does the migration for them.
 */
app.post('/v1/messages', async (req, res) => {
  const start = Date.now();
  const { routing_hint, ...body } = req.body;
  const blocking = routing_hint?.blocking ?? true;

  const complexity = detectComplexity(body, { blocking });
  const decision = route(complexity);

  const cleanBody = stripLegacySamplingParams(body);

  const request = {
    ...cleanBody,
    model: decision.model,
    thinking: decision.thinking,
    output_config: { ...(cleanBody.output_config || {}), effort: decision.effort },
  };

  try {
    let response = await anthropic.messages.create(request);
    let servedModel = decision.model;
    let fellBack = false;

    const { shouldFallback, fallbackModel } = checkFableRefusal(response, decision.model);
    if (shouldFallback) {
      // Fable 5 refused (stop_reason: "refusal", HTTP 200 — not an error).
      // Retry once on the documented fallback target.
      response = await anthropic.messages.create({
        ...request,
        model: fallbackModel,
        output_config: { ...(cleanBody.output_config || {}), effort: 'high' },
      });
      servedModel = fallbackModel;
      fellBack = true;
    }

    const observed = tracker.record({
      model: servedModel,
      requestedModel: decision.model,
      effort: decision.effort,
      complexity,
      usage: response.usage,
      fellBack,
      latencyMs: Date.now() - start,
    });

    res.json({
      ...response,
      _router: {
        requestedModel: decision.model,
        servedModel,
        fellBack,
        effort: decision.effort,
        complexityTier: complexity.tier,
        reason: decision.reason,
        costUsd: observed.totalCostUsd,
        pricingTier: observed.pricingTier,
      },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'proxy error' });
  }
});

/** Cost/routing observability endpoint. */
app.get('/observability/summary', (_req, res) => {
  res.json({
    summary: tracker.summary(),
    postIntroProjection: tracker.projectPostIntroCost(),
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

/**
 * Strip parameters that are deprecated/rejected on Sonnet 5 and Fable 5:
 *   - temperature / top_p / top_k set to non-default values -> 400 on Sonnet 5
 *   - thinking: { type: "enabled", budget_tokens: N } (manual thinking) -> 400 on Sonnet 5
 * This lets existing Sonnet-4.6-era caller code pass through this proxy
 * unmodified during migration; the proxy does the parameter translation.
 * See: https://platform.claude.com/docs/en/about-claude/models/migration-guide
 */
function stripLegacySamplingParams(body) {
  const { temperature, top_p, top_k, thinking, ...rest } = body;
  // thinking is deliberately dropped here — decision.thinking (always
  // { type: 'adaptive' }) is applied by the caller after this function runs.
  return rest;
}

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Adaptive effort router listening on :${PORT}`);
});
