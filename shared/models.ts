import type { HubFile, HubModel } from './types';

const knownSize = (file: HubFile): boolean => Number.isFinite(file.sizeBytes) && file.sizeBytes > 0;
const fitRank = (file?: HubFile): number => !file ? -1 : !knownSize(file) ? 0 : ({ comfortable: 3, tight: 2, 'too-large': 1, unknown: 0 }[file.fit.rating]);
const quantRank = (file: HubFile): number => file.quantization.toUpperCase() === 'Q4_K_M' ? 0 : file.quantization.toUpperCase() === 'Q4_0' ? 1 : 2;
const memory = (file: HubFile): number => file.fit.estimatedMemoryBytes != null && Number.isFinite(file.fit.estimatedMemoryBytes) && file.fit.estimatedMemoryBytes > 0 ? file.fit.estimatedMemoryBytes : knownSize(file) ? file.sizeBytes : Infinity;

/** The model list and file picker share this preference so their fit labels agree. */
export function chooseRecommendedFile(files: readonly HubFile[]): HubFile | undefined {
  return [...files].sort((a, b) => {
    const rank = fitRank(b) - fitRank(a);
    if (rank) return rank;
    if (fitRank(a) >= 2) {
      const quant = quantRank(a) - quantRank(b);
      if (quant) return quant;
    }
    // Tight/oversized fallback should minimize memory; never let an unknown zero-byte size win.
    const size = memory(a) - memory(b);
    return (Number.isNaN(size) ? 0 : size) || a.path.localeCompare(b.path);
  })[0];
}

/** Rank memory-fit candidates first; put the least oversized model first when none fits. */
export function compareRecommendedModels(a: HubModel, b: HubModel): number {
  const left = a.recommendedFile, right = b.recommendedFile;
  const rank = fitRank(right) - fitRank(left);
  if (rank) return rank;
  if (!left || !right) return a.id.localeCompare(b.id);
  if (fitRank(left) === 3) {
    const acceleration = (file: HubFile) => /GPU candidate|Apple unified memory/.test(file.fit.backend) ? 1 : 0;
    const gpu = acceleration(right) - acceleration(left);
    if (gpu) return gpu;
    // Among comfortable candidates in the same execution class, preserve larger model preference.
    return right.sizeBytes - left.sizeBytes || a.id.localeCompare(b.id);
  }
  const size = memory(left) - memory(right);
  return (Number.isNaN(size) ? 0 : size) || a.id.localeCompare(b.id);
}
