export type VRProjection = "NONE" | "180_LR" | "360_TB" | "360";

export function resolveVRProjection(value: unknown): VRProjection {
  switch (value) {
    case "180_LR":
    case "360_TB":
    case "360":
      return value;
    default:
      return "NONE";
  }
}
