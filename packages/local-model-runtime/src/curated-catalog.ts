import type { CuratedLocalModel } from "./types.js";

const GIB = 1024 ** 3;

interface CatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly genericName: string;
  readonly appleName?: string;
  readonly aliases: readonly string[];
  readonly sizeBytes: number;
  readonly minimumMemoryGb: number;
  readonly appleSiliconOnly?: boolean;
}

const CATALOG: readonly CatalogEntry[] = [
  {
    id: "qwen38-27b",
    displayName: "Qwen3.8 27B",
    genericName: "qwen3.8:27b",
    appleName: "qwen3.8:27b-mlx",
    aliases: ["qwen", "qwen3.8", "qwen3", "tongyi", "qwq", "通义", "通義", "千问", "千問"],
    sizeBytes: 18 * GIB,
    minimumMemoryGb: 32
  },
  {
    id: "gpt-oss-20b",
    displayName: "gpt-oss 20B",
    genericName: "gpt-oss:20b",
    aliases: ["gpt", "openai", "oss", "gpt-oss"],
    sizeBytes: 14 * GIB,
    minimumMemoryGb: 16
  },
  {
    id: "gemma4-e2b",
    displayName: "Gemma 4 E2B",
    genericName: "gemma4:e2b",
    appleName: "gemma4:e2b-mlx",
    aliases: ["gemma", "gemma4", "google"],
    sizeBytes: 6.2 * GIB,
    minimumMemoryGb: 8
  },
  {
    id: "gemma4-e4b",
    displayName: "Gemma 4 E4B",
    genericName: "gemma4:e4b",
    appleName: "gemma4:e4b-mlx",
    aliases: ["gemma", "gemma4", "google"],
    sizeBytes: 7.2 * GIB,
    minimumMemoryGb: 12
  },
  {
    id: "gemma4-12b",
    displayName: "Gemma 4 12B",
    genericName: "gemma4:12b",
    appleName: "gemma4:12b-mlx",
    aliases: ["gemma", "gemma4", "google"],
    sizeBytes: 8.5 * GIB,
    minimumMemoryGb: 16
  },
  {
    id: "gemma4-31b",
    displayName: "Gemma 4 31B",
    genericName: "gemma4:31b",
    appleName: "gemma4:31b-mlx",
    aliases: ["gemma", "gemma4", "google"],
    sizeBytes: 20 * GIB,
    minimumMemoryGb: 32
  },
  {
    id: "gemma4-26b",
    displayName: "Gemma 4 26B",
    genericName: "gemma4:26b",
    appleName: "gemma4:26b-mlx",
    aliases: ["gemma", "gemma4", "google"],
    sizeBytes: 18 * GIB,
    minimumMemoryGb: 32
  },
  {
    id: "ornith15-35b",
    displayName: "Ornith 1.5 35B",
    genericName: "hf.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF:Q4_K_M",
    aliases: ["ornith", "coder", "code", "coding", "agent"],
    sizeBytes: 21.7 * GIB,
    minimumMemoryGb: 32
  },
  {
    id: "glm-47-flash",
    displayName: "GLM-4.7 Flash",
    genericName: "glm-4.7-flash",
    aliases: ["glm", "flash", "coder", "code", "coding", "zhipu"],
    sizeBytes: 19 * GIB,
    minimumMemoryGb: 32
  }
] as const;

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
    .filter((model) => model.appleSiliconOnly !== true || apple)
    .map((model) => {
      if (model.id === "qwen38-27b" && apple && memoryGb >= 64) {
        return {
          id: model.id,
          displayName: model.displayName,
          libraryName: "qwen3.8:27b-mxfp8",
          aliases: model.aliases,
          sizeBytes: 32 * GIB,
          minimumMemoryGb: 64,
          appleSiliconOnly: true
        };
      }
      return {
        id: model.id,
        displayName: model.displayName,
        libraryName: apple && model.appleName !== undefined ? model.appleName : model.genericName,
        aliases: model.aliases,
        sizeBytes: Math.round(model.sizeBytes),
        minimumMemoryGb: model.minimumMemoryGb,
        appleSiliconOnly: apple && model.appleName !== undefined ? true : model.appleSiliconOnly === true
      };
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
  const featured = ["qwen38-27b", "gpt-oss-20b", "ornith15-35b"];
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
