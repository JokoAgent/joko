import type { CuratedLocalModel } from "./types.js";

const GIB = 1024 ** 3;

interface CatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly variants: readonly {
    readonly libraryName: string;
    readonly sizeBytes: number;
    readonly minimumMemoryGb: number;
    readonly appleSiliconOnly?: boolean;
  }[];
}

const CATALOG: readonly CatalogEntry[] = [
  {
    "id": "qwen38-27b",
    "displayName": "Qwen3.8 27B",
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
    "variants": [
      {
        "libraryName": "qwen3.8:27b-mxfp8",
        "sizeBytes": 31655335990,
        "minimumMemoryGb": 64,
        "appleSiliconOnly": true
      },
      {
        "libraryName": "qwen3.8:27b-mlx",
        "sizeBytes": 18174721596,
        "minimumMemoryGb": 32,
        "appleSiliconOnly": true
      },
      {
        "libraryName": "qwen3.8:27b",
        "sizeBytes": 17741871939,
        "minimumMemoryGb": 32,
        "appleSiliconOnly": false
      }
    ]
  },
  {
    "id": "qwen35-4b",
    "displayName": "Qwen3.5 4B",
    "aliases": [
      "qwen",
      "qwen3.5",
      "通义",
      "通義",
      "千问",
      "千問"
    ],
    "variants": [
      {
        "libraryName": "qwen3.5:4b-mlx",
        "sizeBytes": 3973304734,
        "minimumMemoryGb": 8,
        "appleSiliconOnly": true
      },
      {
        "libraryName": "qwen3.5:4b-q4_K_M",
        "sizeBytes": 3389983260,
        "minimumMemoryGb": 8
      }
    ]
  },
  {
    "id": "qwen35-9b",
    "displayName": "Qwen3.5 9B",
    "aliases": [
      "qwen",
      "qwen3.5",
      "通义",
      "通義",
      "千问",
      "千問"
    ],
    "variants": [
      {
        "libraryName": "qwen3.5:9b-mlx",
        "sizeBytes": 8903014479,
        "minimumMemoryGb": 16,
        "appleSiliconOnly": true
      },
      {
        "libraryName": "qwen3.5:9b-q4_K_M",
        "sizeBytes": 6594474236,
        "minimumMemoryGb": 16
      }
    ]
  },
  {
    "id": "gemma4-12b",
    "displayName": "Gemma 4 12B",
    "aliases": [
      "gemma",
      "gemma4",
      "google",
      "宝石",
      "寶石"
    ],
    "variants": [
      {
        "libraryName": "gemma4:12b-mlx",
        "sizeBytes": 7714091072,
        "minimumMemoryGb": 16,
        "appleSiliconOnly": true
      },
      {
        "libraryName": "gemma4:12b-it-q4_K_M",
        "sizeBytes": 7556507848,
        "minimumMemoryGb": 16
      }
    ]
  },
  {
    "id": "qwen36-35b",
    "displayName": "Qwen3.6 35B A3B",
    "aliases": [
      "qwen",
      "qwen3.6",
      "通义",
      "通義",
      "moe"
    ],
    "variants": [
      {
        "libraryName": "qwen3.6:35b-mlx",
        "sizeBytes": 23598465441,
        "minimumMemoryGb": 32,
        "appleSiliconOnly": true
      },
      {
        "libraryName": "qwen3.6:35b-a3b-q4_K_M",
        "sizeBytes": 23938333115,
        "minimumMemoryGb": 32
      }
    ]
  },
  {
    "id": "nemotron35-30b",
    "displayName": "Nemotron 3.5 Lightning 30B",
    "aliases": [
      "nemotron",
      "nvidia",
      "lightning",
      "moe"
    ],
    "variants": [
      {
        "libraryName": "nemotron-3.5-lightning:30b-mlx",
        "sizeBytes": 22666641292,
        "minimumMemoryGb": 48,
        "appleSiliconOnly": true
      },
      {
        "libraryName": "nemotron-3.5-lightning:30b",
        "sizeBytes": 25430749137,
        "minimumMemoryGb": 48
      }
    ]
  },
  {
    "id": "qwen38-flash-next",
    "displayName": "Qwen3.8 Flash-Next",
    "aliases": [
      "qwen",
      "flash-next",
      "通义",
      "通義",
      "moe"
    ],
    "variants": [
      {
        "libraryName": "qwen3.8-flash-next:125b-mlx",
        "sizeBytes": 104852025885,
        "minimumMemoryGb": 192,
        "appleSiliconOnly": true
      },
      {
        "libraryName": "qwen3.8-flash-next:125b-a6b-q4_K_M",
        "sizeBytes": 120058268208,
        "minimumMemoryGb": 192
      }
    ]
  },
  {
    "id": "laguna-s21-118b",
    "displayName": "Laguna S 2.1 118B A8B",
    "aliases": [
      "laguna",
      "poolside",
      "laguna-s-2.1",
      "118b",
      "moe"
    ],
    "variants": [
      {
        "libraryName": "laguna-s-2.1:nvfp4",
        "sizeBytes": 66189691080,
        "minimumMemoryGb": 128,
        "appleSiliconOnly": true
      },
      {
        "libraryName": "laguna-s-2.1:q4_K_M",
        "sizeBytes": 96031832391,
        "minimumMemoryGb": 192
      }
    ]
  }
];

function isAppleSilicon(platform: NodeJS.Platform, arch: NodeJS.Architecture): boolean {
  return platform === "darwin" && arch === "arm64";
}

export function curatedModelsForHost(input: {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly totalMemoryBytes: number;
}): readonly CuratedLocalModel[] {
  const apple = isAppleSilicon(input.platform, input.arch);
  const memoryGb = Math.max(0, Math.floor(input.totalMemoryBytes / GIB));
  return CATALOG
    .flatMap((model) => {
      const variants = model.variants.filter(variant => variant.appleSiliconOnly !== true || apple);
      const variant = variants.find(value => memoryGb >= value.minimumMemoryGb)
        ?? [...variants].sort((left, right) => left.minimumMemoryGb - right.minimumMemoryGb)[0];
      return variant === undefined ? [] : [{
        id: model.id,
        displayName: model.displayName,
        aliases: model.aliases,
        ...variant,
        appleSiliconOnly: variant.appleSiliconOnly === true
      }];
    })
    .sort((left, right) => {
      const leftFits = memoryGb >= left.minimumMemoryGb ? 0 : 1;
      const rightFits = memoryGb >= right.minimumMemoryGb ? 0 : 1;
      return leftFits - rightFits || left.minimumMemoryGb - right.minimumMemoryGb || left.displayName.localeCompare(right.displayName, "en");
    });
}

export function recommendedModelsForHost(input: {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly totalMemoryBytes: number;
}): readonly CuratedLocalModel[] {
  const memoryGb = Math.max(0, Math.floor(input.totalMemoryBytes / GIB));
  const catalog = curatedModelsForHost(input);
  const fitting = catalog.filter((model) => memoryGb >= model.minimumMemoryGb);
  const featured = ["qwen38-flash-next", "qwen38-27b"];
  return featured.flatMap((id) => fitting.find((model) => model.id === id) ?? []).slice(0, 3);
}

export function modelPreflight(input: {
  readonly model: Pick<CuratedLocalModel, "sizeBytes" | "minimumMemoryGb" | "appleSiliconOnly">;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly totalMemoryBytes?: number;
  readonly freeDiskBytes?: number;
}) {
  const requiredDiskBytes = Math.ceil(input.model.sizeBytes * 1.15 + 2 * GIB);
  const totalMemoryGb = input.totalMemoryBytes === undefined ? undefined : input.totalMemoryBytes / GIB;
  const memory = totalMemoryGb === undefined
    ? "unknown" as const
    : totalMemoryGb >= input.model.minimumMemoryGb
      ? "sufficient" as const
      : "constrained" as const;
  const disk = input.freeDiskBytes === undefined
    ? "unknown" as const
    : input.freeDiskBytes >= requiredDiskBytes
      ? "sufficient" as const
      : "insufficient" as const;
  const platformAllowed = input.model.appleSiliconOnly !== true || isAppleSilicon(input.platform, input.arch);
  return {
    allowed: platformAllowed && disk !== "insufficient",
    memory,
    disk,
    requiredDiskBytes,
    ...(!platformAllowed
      ? { publicErrorCode: "UNSUPPORTED_PLATFORM" as const }
      : disk === "insufficient"
        ? { publicErrorCode: "DISK_SPACE_LOW" as const }
        : {})
  };
}
