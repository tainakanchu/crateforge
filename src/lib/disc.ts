export function defaultDevice(): string {
  if (navigator.userAgent.includes("Win")) return "D:";
  if (navigator.userAgent.includes("Mac")) return "disk1";
  return "/dev/cdrom";
}
