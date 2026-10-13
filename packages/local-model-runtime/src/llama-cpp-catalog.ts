import type { LlamaCppCatalogEntry, LlamaCppSnapshot } from "./llama-cpp-types.js";

export const LLAMA_CPP_CATALOG: readonly LlamaCppCatalogEntry[] = [
  {
    "id": "qwen38-27b",
    "name": "Qwen3.8 27B",
    "aliases": [
      "qwen",
      "qwen3.8",
      "qwen3",
      "tongyi",
      "qwq",
      "通义",
      "通義",
      "千问",
      "千問"
    ],
    "descriptions": {
      "en": "Capability pick based on independent benchmarks; local quantization can affect results.",
      "zh-CN": "依据独立跑分保留的能力推荐，本地量化效果仍可能有差异。",
      "zh-TW": "依據獨立跑分保留的能力推薦，本機量化效果仍可能有差異。",
      "ja": "独立評価に基づく能力重視の推奨。ローカルの量子化で結果は変わり得ます。",
      "ko": "독립 벤치마크에 따른 성능 추천입니다. 로컬 양자화에 따라 결과가 달라질 수 있습니다."
    },
    "variants": [
      {
        "repository": "ggml-org/Qwen3.8-27B-GGUF",
        "file": "Qwen3.8-27B-Q4_K_M.gguf",
        "quantization": "Q4_K_M",
        "sizeBytes": 18973870528,
        "verifiedAt": "2026-09-25"
      }
    ]
  },
  {
    "id": "qwen35-4b",
    "name": "Qwen3.5 4B",
    "aliases": [
      "qwen",
      "qwen3.5",
      "通义",
      "通義",
      "千问",
      "千問"
    ],
    "descriptions": {
      "en": "Low-memory candidate; comparable speed and memory tests are pending.",
      "zh-CN": "低内存候选，待补齐同条件速度与内存实测。",
      "zh-TW": "低記憶體候選，待補齊相同條件的速度與記憶體實測。",
      "ja": "省メモリ候補。同条件での速度とメモリの実測待ち。",
      "ko": "저메모리 후보. 동일 조건의 속도와 메모리 실측이 필요합니다."
    },
    "variants": [
      {
        "repository": "bartowski/Qwen_Qwen3.5-4B-GGUF",
        "file": "Qwen_Qwen3.5-4B-Q4_K_M.gguf",
        "quantization": "Q4_K_M",
        "sizeBytes": 3013027808,
        "verifiedAt": "2026-09-25"
      }
    ]
  },
  {
    "id": "qwen35-9b",
    "name": "Qwen3.5 9B",
    "aliases": [
      "qwen",
      "qwen3.5",
      "通义",
      "通義",
      "千问",
      "千問"
    ],
    "descriptions": {
      "en": "Low-memory candidate to compare with Gemma 4 12B.",
      "zh-CN": "低内存候选，待与 Gemma 4 12B 比较。",
      "zh-TW": "低記憶體候選，待與 Gemma 4 12B 比較。",
      "ja": "省メモリ候補。Gemma 4 12B との比較待ち。",
      "ko": "저메모리 후보. Gemma 4 12B와 비교가 필요합니다."
    },
    "variants": [
      {
        "repository": "bartowski/Qwen_Qwen3.5-9B-GGUF",
        "file": "Qwen_Qwen3.5-9B-Q4_K_M.gguf",
        "quantization": "Q4_K_M",
        "sizeBytes": 6169341984,
        "verifiedAt": "2026-09-25"
      }
    ]
  },
  {
    "id": "gemma4-12b",
    "name": "Gemma 4 12B",
    "aliases": [
      "gemma",
      "gemma4",
      "google",
      "宝石",
      "寶石"
    ],
    "descriptions": {
      "en": "Low-memory candidate to compare with Qwen3.5 9B.",
      "zh-CN": "低内存候选，待与 Qwen3.5 9B 比较。",
      "zh-TW": "低記憶體候選，待與 Qwen3.5 9B 比較。",
      "ja": "省メモリ候補。Qwen3.5 9B との比較待ち。",
      "ko": "저메모리 후보. Qwen3.5 9B와 비교가 필요합니다."
    },
    "variants": [
      {
        "repository": "bartowski/gemma-4-12B-it-GGUF",
        "file": "gemma-4-12B-it-Q4_K_M.gguf",
        "quantization": "Q4_K_M",
        "sizeBytes": 7662533088,
        "verifiedAt": "2026-09-25"
      }
    ]
  },
  {
    "id": "qwen36-35b",
    "name": "Qwen3.6 35B A3B",
    "aliases": [
      "qwen",
      "qwen3.6",
      "通义",
      "通義",
      "moe"
    ],
    "descriptions": {
      "en": "Speed candidate; a comparison with Nemotron is pending.",
      "zh-CN": "速度候选，待与 Nemotron 做同条件比较。",
      "zh-TW": "速度候選，待與 Nemotron 做相同條件比較。",
      "ja": "速度重視の候補。Nemotron との同条件比較待ち。",
      "ko": "속도 후보. Nemotron과 동일 조건 비교가 필요합니다."
    },
    "variants": [
      {
        "repository": "ggml-org/Qwen3.6-35B-A3B-GGUF",
        "file": "Qwen3.6-35B-A3B-Q4_K_M.gguf",
        "quantization": "Q4_K_M",
        "sizeBytes": 20419565568,
        "verifiedAt": "2026-09-25"
      }
    ]
  },
  {
    "id": "nemotron35-30b",
    "name": "Nemotron 3.5 Lightning 30B",
    "aliases": [
      "nemotron",
      "nvidia",
      "lightning",
      "moe"
    ],
    "descriptions": {
      "en": "Speed candidate; a comparison with Qwen3.6 is pending.",
      "zh-CN": "速度候选，待与 Qwen3.6 做同条件比较。",
      "zh-TW": "速度候選，待與 Qwen3.6 做相同條件比較。",
      "ja": "速度重視の候補。Qwen3.6 との同条件比較待ち。",
      "ko": "속도 후보. Qwen3.6과 동일 조건 비교가 필요합니다."
    },
    "variants": [
      {
        "repository": "bartowski/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF",
        "file": "NVIDIA-Nemotron-3.5-Lightning-30B-A3B-Q4_K_M.gguf",
        "quantization": "Q4_K_M",
        "sizeBytes": 25477403616,
        "verifiedAt": "2026-09-25"
      }
    ]
  },
  {
    "id": "qwen38-flash-next",
    "name": "Qwen3.8 Flash-Next",
    "aliases": [
      "qwen",
      "flash-next",
      "通义",
      "通義",
      "moe"
    ],
    "descriptions": {
      "en": "Capability pick for high-memory computers (192 GB or more). Local speed and peak memory still need testing.",
      "zh-CN": "192 GB 及以上大内存电脑的能力主推，本机速度与峰值内存仍待实测。",
      "zh-TW": "192 GB 以上大記憶體電腦的能力主推，本機速度與峰值記憶體仍待實測。",
      "ja": "192 GB 以上の大容量メモリ向けの性能重視の推奨。ローカルの速度とピークメモリは要検証です。",
      "ko": "192 GB 이상 대용량 메모리 컴퓨터의 성능 추천. 로컬 속도와 최대 메모리는 추가 검증이 필요합니다."
    },
    "variants": [
      {
        "repository": "bartowski/Qwen3.8-Flash-Next-GGUF",
        "file": "Qwen3.8-Flash-Next-Q4_K_M/Qwen3.8-Flash-Next-Q4_K_M-00001-of-00004.gguf",
        "quantization": "Q4_K_M",
        "sizeBytes": 119599030080,
        "verifiedAt": "2026-09-25"
      }
    ]
  },
  {
    "id": "laguna-s21-118b",
    "name": "Laguna S 2.1 118B A8B",
    "aliases": [
      "laguna",
      "poolside",
      "laguna-s-2.1",
      "118b",
      "moe"
    ],
    "descriptions": {
      "en": "Coding candidate with a smaller Mac download than Flash-Next. Memory thresholds are estimates; Ollama tool use, speed and peak memory are unverified.",
      "zh-CN": "Mac 下载体积小于 Flash-Next 的编程候选。内存门槛为估计，Ollama 工具调用、速度与峰值内存仍待验证。",
      "zh-TW": "Mac 下載體積小於 Flash-Next 的程式設計候選。記憶體門檻為估計，Ollama 工具呼叫、速度與峰值記憶體仍待驗證。",
      "ja": "Mac 用のダウンロードが Flash-Next より小さいコーディング候補。メモリ要件は推定値。Ollama のツール呼び出し、速度、ピークメモリは未検証です。",
      "ko": "Mac 다운로드 크기가 Flash-Next보다 작은 코딩 후보. 메모리 기준은 추정치이며 Ollama 도구 호출, 속도, 최대 메모리는 미검증입니다."
    },
    "variants": [
      {
        "repository": "poolside/Laguna-S-2.1-GGUF",
        "file": "laguna-s-2.1-Q4_K_M.gguf",
        "quantization": "Q4_K_M",
        "sizeBytes": 96031829760,
        "verifiedAt": "2026-09-25"
      }
    ]
  }
];

/** Model-level shortlist. GGUF weight size excludes unsuitable candidates;
 * it does not establish inference speed or peak-memory requirements. */
export function llamaCppRecommendation(platform: NodeJS.Platform, arch: string, totalMemoryBytes: number, chip?: string): LlamaCppSnapshot["recommendation"] {
  const memoryGb = Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0 ? Math.floor(totalMemoryBytes / 1024 ** 3) : 0;
  const featuredIds = ["qwen38-flash-next", "qwen38-27b"].filter(id => {
    const model = LLAMA_CPP_CATALOG.find(entry => entry.id === id);
    const minimum = id === "qwen38-flash-next" ? 192 : 32;
    return memoryGb >= minimum && model?.variants.some(variant => variant.sizeBytes < totalMemoryBytes) === true;
  });
  return { featuredIds, memoryGb, appleSilicon: platform === "darwin" && arch === "arm64", ...(chip === undefined ? {} : { chip }) };
}
