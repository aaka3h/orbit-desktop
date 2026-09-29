import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseRecommendedFile, compareRecommendedModels } from '../shared/models';
import type { HubFile, HubModel, ModelFit } from '../shared/types';

function file(quantization: string, rating: ModelFit['rating'], sizeBytes: number, estimatedMemoryBytes: number | null = sizeBytes * 1.3): HubFile {
  return { path: `${quantization}-${sizeBytes}.gguf`, quantization, sizeBytes, ollamaModel: `hf.co/test/model:${quantization}.gguf`, fit: { rating, estimatedMemoryBytes, backend: 'CPU fallback · may be slow', explanation: 'Test fixture' } };
}
function model(id: string, recommendedFile?: HubFile): HubModel { return { id, downloads: 0, likes: 0, gated: false, tags: [], recommendedFile }; }

test('recommended quantization prefers memory fit over an oversized Q4', () => {
  const small = file('Q3_K_M', 'comfortable', 200);
  assert.equal(chooseRecommendedFile([file('Q4_K_M', 'too-large', 400), small, file('Q4_0', 'tight', 350)]), small);
});

test('comfortable and tight tiers prefer Q4_K_M, then Q4_0, then smallest other file', () => {
  for (const rating of ['comfortable', 'tight'] as const) {
    const q4 = file('Q4_K_M', rating, 400), legacy = file('Q4_0', rating, 350), tiny = file('Q3_K_M', rating, 200), large = file('Q8_0', rating, 800);
    assert.equal(chooseRecommendedFile([tiny, legacy, q4, large]), q4);
    assert.equal(chooseRecommendedFile([large, tiny, legacy]), legacy);
    assert.equal(chooseRecommendedFile([large, tiny]), tiny);
  }
});

test('oversized selection prefers smallest memory estimate and unknown fit comes last', () => {
  const smaller = file('Q3_K_M', 'too-large', 200, 300);
  assert.equal(chooseRecommendedFile([file('Q4_K_M', 'too-large', 500, 700), file('IQ2', 'unknown', 100), smaller]), smaller);
  assert.equal(chooseRecommendedFile([file('Q4_K_M', 'unknown', 0, null), file('Q3_K_M', 'unknown', 50, null)])?.sizeBytes, 50);
});

test('selection is immutable and empty model lists have no recommendation', () => {
  const files = [file('Q8', 'comfortable', 800), file('Q4_K_M', 'comfortable', 400)];
  const before = [...files];
  chooseRecommendedFile(files);
  assert.deepEqual(files, before);
  assert.equal(chooseRecommendedFile([]), undefined);
});

test('all oversized model recommendations order by smallest memory first', () => {
  const models = [model('large', file('Q4_K_M', 'too-large', 8, 12)), model('small', file('Q4_K_M', 'too-large', 2, 4)), model('medium', file('Q4_K_M', 'too-large', 4, 7))];
  assert.deepEqual(models.sort(compareRecommendedModels).map(item => item.id), ['small', 'medium', 'large']);
});

test('model rankings put comfortable before tight before oversized before unknown/missing', () => {
  const models = [model('missing'), model('unknown', file('Q4', 'unknown', 0)), model('oversize', file('Q4', 'too-large', 50)), model('tight', file('Q4', 'tight', 60)), model('comfortable', file('Q4', 'comfortable', 80))];
  assert.deepEqual(models.sort(compareRecommendedModels).map(item => item.id), ['comfortable', 'tight', 'oversize', 'unknown', 'missing']);
});

test('comfortable GPU candidates rank first, then larger comfortable models in the same class', () => {
  const accelerated = file('Q4_K_M', 'comfortable', 2);
  accelerated.fit.backend = 'NVIDIA GPU candidate · compatibility unverified';
  const models = [model('cpu-small', file('Q4_K_M', 'comfortable', 3)), model('cpu-large', file('Q4_K_M', 'comfortable', 6)), model('gpu', accelerated)];
  assert.deepEqual(models.sort(compareRecommendedModels).map(item => item.id), ['gpu', 'cpu-large', 'cpu-small']);
});
