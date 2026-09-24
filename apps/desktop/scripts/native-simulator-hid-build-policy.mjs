export function selectSimulatorHidArchitectures(value, hostArch) {
  const available = new Set(String(value).trim().split(/\s+/u).filter(Boolean));
  const supportsArm = available.has("arm64") || available.has("arm64e");
  const supportsX64 = available.has("x86_64");
  if (hostArch === "arm64" && !supportsArm || hostArch === "x64" && !supportsX64) {
    return { architectures: [], manifestArchitecture: hostArch === "x64" ? "x86_64" : hostArch };
  }
  if (hostArch !== "arm64" && hostArch !== "x64") {
    return { architectures: [], manifestArchitecture: hostArch };
  }
  const architectures = [
    ...(supportsArm ? ["arm64"] : []),
    ...(supportsX64 ? ["x86_64"] : [])
  ];
  return { architectures,
    manifestArchitecture: architectures.length === 2 ? "universal" : architectures[0] };
}
