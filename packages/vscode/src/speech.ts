// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export function speakableAnswerText(text: string): string {
  let spoken = String(text || "");
  spoken = spoken.replace(/```[\s\S]*?```/g, " Code block. ");
  spoken = spoken.split(/\n/).filter(line => !/^\s*Sources?\s*:/i.test(line)).join("\n");
  spoken = spoken.replace(/[`*_#>|]/g, " ").replace(/\s+/g, " ").trim();
  if (spoken.length > 2600) {
    const cut = spoken.slice(0, 2600);
    spoken = cut.slice(0, Math.max(cut.lastIndexOf(". ") + 1, 2000)) + " The rest is on screen.";
  }
  return spoken;
}
