import { Notice } from "obsidian";

/**
 * Opens a URL in the user's default external application.
 */
export const openExternal: (url: string) => Promise<void> = async (
  url: string
) => {
  try {
    await window.open(url);
  } catch {
    new Notice("Failed to open in external application.");
  }
};
