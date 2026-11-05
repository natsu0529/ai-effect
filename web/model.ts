// training/train.ts で学習したロジスティック回帰で、記事ごとの AI らしさを確率として出す

import { computeFeatures, FEATURES } from "./features";
import model from "./model.json";

const labelOf = new Map(FEATURES.map((f) => [f.key, f.label]));

export const MODEL_EVAL = model.eval;

export interface Prediction {
  probability: number;
  // AI 寄りに押した特徴量の上位。表で判定の根拠として見せる
  reasons: string[];
}

export function predict(text: string): Prediction {
  const f = computeFeatures(text);
  const contrib = model.features.map((key, j) => ({
    key,
    value: model.weights[j] * ((f[key] - model.mean[j]) / model.std[j]),
  }));
  const z = contrib.reduce((s, c) => s + c.value, model.bias);
  const reasons = contrib
    .filter((c) => c.value > 0.3)
    .sort((a, b) => b.value - a.value)
    .slice(0, 2)
    .map((c) => labelOf.get(c.key) ?? c.key);
  return { probability: 1 / (1 + Math.exp(-z)), reasons };
}
