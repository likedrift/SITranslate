import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_SETTINGS, type TranslationInput} from '../src/core/types.ts';
import {estimateOutputTokens} from '../src/core/text.ts';
import {parseSegments} from '../src/core/validation.ts';
import {streamSegment} from '../src/core/stream-text.ts';
import {CompatibleAdapter, systemPrompt} from '../src/core/provider.ts';
import {Utterances} from '../src/core/utterances.ts';
import {LIVE_CONTEXT_CHARS, LIVE_MAX_TOKENS_CAP, LIVE_MAX_TOKENS_FLOOR, isLiveSubtitle, liveContext, liveJsonInstruction, liveMaxTokens} from '../src/core/live-translate.ts';

const pageInput: TranslationInput = {kind:'page', profileId:'deepseek-default', taskId:'task', requestId:'request', target:'zh-Hans', blocks:[{id:'b1', context:'前文', segments:[{id:'s1', text:'Hello'}]}]};
const liveInput = (text: string, taskId = 'subtitle-live-sess'): TranslationInput => ({kind:'subtitle', profileId:'deepseek-default', taskId, requestId:'request', target:'zh-Hans', blocks:[{id:'live', context:'前の文です。', segments:[{id:'live', text}]}]});
const budget = (text: string) => liveMaxTokens(estimateOutputTokens(text));

test('live subtitle prompt is shorter, spoken, and still names the existing JSON shape', () => {
  const language = '简体中文';
  const page = systemPrompt(pageInput, language);
  const live = systemPrompt(liveInput('こんにちは。'), language);
  const video = systemPrompt({...liveInput('Hello'), taskId:'subtitle-cue'}, language);
  assert.ok(live.length < page.length * 0.8, `live ${live.length} should be well under page ${page.length}`);
  assert.equal(video, page);
  assert.match(live, /spoken subtitle/);
  assert.match(live, /noisy ASR/);
  assert.match(live, /mishearings/);
  assert.match(live, /proper nouns/);
  assert.match(live, /untrusted data/);
  assert.match(live, /id before text/);
  assert.match(live, /no markdown/);
  assert.match(live, /\{"segments":\[\{"id":"original-id","text":"translation"\}\]\}/);
  assert.equal(live.includes(liveJsonInstruction), true);
  assert.equal(page.includes('links and formatting'), true);
  assert.equal(live.includes('links and formatting'), false);
  assert.equal(live.includes('same paragraph'), false);
  assert.match(live, /Target language: 简体中文 \(zh-Hans\)\./);
});

test('only subtitle-live task ids take the live request path', () => {
  assert.equal(isLiveSubtitle(liveInput('あ')), true);
  assert.equal(isLiveSubtitle({kind:'subtitle', taskId:'subtitle-live'}), false);
  assert.equal(isLiveSubtitle({kind:'subtitle', taskId:'subtitle-abc'}), false);
  assert.equal(isLiveSubtitle({kind:'page', taskId:'subtitle-live-sess'}), false);
  assert.equal(isLiveSubtitle({kind:'selection', taskId:'subtitle-live-sess'}), false);
});

test('live max_tokens follows the current line and stays under the page floor for spoken lengths', () => {
  assert.equal(LIVE_MAX_TOKENS_FLOOR < 1024, true);
  assert.equal(liveMaxTokens(0), LIVE_MAX_TOKENS_FLOOR);
  assert.equal(liveMaxTokens(Number.NaN), LIVE_MAX_TOKENS_FLOOR);
  const short = budget('はい。');
  const line = budget('あ'.repeat(36));
  const longer = budget('あ'.repeat(80));
  const huge = budget('あ'.repeat(400));
  assert.ok(short < 256 && short < 1024);
  assert.ok(line > short && line < 512);
  assert.ok(longer > line && longer < 1024);
  assert.ok(huge > 1024 && huge <= LIVE_MAX_TOKENS_CAP);
  let previous = 0;
  for (const length of [1, 8, 12, 36, 80, 120, 200, 400]) {
    const text = 'あ'.repeat(length);
    const tokens = budget(text);
    assert.ok(tokens >= previous);
    assert.ok(tokens >= estimateOutputTokens(text));
    assert.ok(tokens <= LIVE_MAX_TOKENS_CAP);
    previous = tokens;
  }
});

test('live context keeps the newest 300 characters', () => {
  assert.equal(LIVE_CONTEXT_CHARS, 300);
  assert.equal(liveContext('', ''), '');
  assert.equal(liveContext(' 前 ', ''), '前');
  assert.equal(liveContext('前', '後'), '前 後');
  const combined = liveContext('あ'.repeat(250), 'い'.repeat(100));
  assert.equal(combined.length, 300);
  assert.equal(combined.endsWith('い'.repeat(100)), true);
  assert.equal(combined.includes('あ'.repeat(250)), false);
  const sentences = Array.from({length:40}, (_,i) => `第${String(i).padStart(2,'0')}番です。`).reduce((prior, line) => liveContext(prior, line), '');
  assert.ok(sentences.length <= LIVE_CONTEXT_CHARS && sentences.length >= LIVE_CONTEXT_CHARS - 1);
  assert.equal(sentences.startsWith(' '), false);
  assert.equal(liveContext(sentences, ''), sentences);
});

test('same-utterance prior context uses the live window', () => {
  const first = '起'.repeat(35) + '。';
  const mid = '中'.repeat(35) + '。';
  const last = '末'.repeat(20) + '。';
  const pieces = new Utterances().update('long', first + mid.repeat(10) + last, true, 0);
  assert.ok(pieces.length > 2);
  for (const piece of pieces) assert.ok((piece.context ?? '').length <= LIVE_CONTEXT_CHARS);
  const tail = pieces.at(-1)!;
  assert.equal(tail.text, last);
  assert.equal(tail.context?.includes('起'), false);
  assert.equal(tail.context?.includes('中'), true);
  assert.equal(tail.context?.length, LIVE_CONTEXT_CHARS);
});

test('the compact live JSON shell still parses and streams the first character', () => {
  const blocks = [{id:'live', context:'前の文です。', segments:[{id:'live', text:'やまださん、こんにちは。'}]}];
  const compact = '{"segments":[{"id":"live","text":"山田，你好。"}]}';
  assert.deepEqual(parseSegments(compact, blocks), [{id:'live', text:'山田，你好。'}]);
  assert.deepEqual(parseSegments('```json\n' + compact + '\n```', blocks), [{id:'live', text:'山田，你好。'}]);
  assert.deepEqual(parseSegments('{"segments":[{"text":"山田，你好。","id":"live"}]}', blocks), [{id:'live', text:'山田，你好。'}]);
  const prefix = '{"segments":[{"id":"live","text":"';
  assert.equal(streamSegment(prefix + '山', 'live'), '山');
  assert.equal(streamSegment(prefix + '山田', 'live'), '山田');
  assert.deepEqual(parseSegments(prefix + '山田，你好。"}]}', blocks), [{id:'live', text:'山田，你好。'}]);
  assert.equal(streamSegment('{"segments":[{"text":"山', 'live'), undefined);
});

test('live requests send the short prompt and a line-sized max_tokens; page and video subtitles do not', async () => {
  const original = globalThis.fetch;
  const requests: {input: TranslationInput; body: any}[] = [];
  globalThis.fetch = (async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    const input = requests.at(-1)!.input;
    requests[requests.length - 1].body = body;
    const segments = input.blocks.flatMap(block => block.segments.map(segment => ({id:segment.id, text:'译文'})));
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({segments})}}], usage:{prompt_tokens:10, completion_tokens:5}}));
  }) as typeof fetch;
  const profile = {...DEFAULT_SETTINGS.profiles[0], apiKey:'test-only', stream:false};
  const send = async (input: TranslationInput) => {
    requests.push({input, body:undefined});
    return new CompatibleAdapter().translate(profile, input, new AbortController().signal);
  };
  try {
    const short = await send(liveInput('はい。'));
    const medium = await send(liveInput('あ'.repeat(36)));
    const page = await send(pageInput);
    const video = await send({...liveInput('Hello from the player.'), taskId:'subtitle-track'});
    assert.equal(short.segments[0].text, '译文');
    assert.equal(medium.segments[0].text, '译文');
    const [shortReq, mediumReq, pageReq, videoReq] = requests.map(item => item.body);
    assert.equal(shortReq.max_tokens, budget('はい。'));
    assert.equal(mediumReq.max_tokens, budget('あ'.repeat(36)));
    assert.ok(shortReq.max_tokens < 1024 && mediumReq.max_tokens > shortReq.max_tokens && mediumReq.max_tokens < 1024);
    assert.ok(pageReq.max_tokens >= 1024 && pageReq.max_tokens <= 8192);
    assert.ok(videoReq.max_tokens >= 1024 && videoReq.max_tokens <= 8192);
    assert.equal(shortReq.messages[0].content, systemPrompt(liveInput('はい。'), '简体中文'));
    assert.equal(pageReq.messages[0].content, systemPrompt(pageInput, '简体中文'));
    assert.equal(videoReq.messages[0].content, pageReq.messages[0].content);
    assert.equal(shortReq.messages[0].content.includes('noisy ASR'), true);
    assert.equal(pageReq.messages[0].content.includes('links and formatting'), true);
    for (const body of [shortReq, mediumReq, pageReq, videoReq]) {
      const user = JSON.parse(body.messages[1].content);
      assert.ok(Array.isArray(user.blocks));
      assert.equal(body.messages[0].content.includes('{"segments":[{"id":"original-id","text":"translation"}]}'), true);
    }
    assert.equal(JSON.parse(shortReq.messages[1].content).blocks[0].segments[0].id, 'live');
  } finally {
    globalThis.fetch = original;
  }
});
