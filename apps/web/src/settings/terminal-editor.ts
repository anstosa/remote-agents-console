import { createContext, useContext } from 'react';

// identify an installed source without accepting browser-supplied file paths
export type SettingsEditorTarget = { sourceId: string; revisionId: string };

// preview only redacted catalog bytes without reading an arbitrary host path
export type SettingsPreviewTarget = { path: string; content: string };

// keep terminal ownership with the workspace rendering the Settings split
export const SettingsTerminalEditorContext = createContext<{
  configured: boolean;
  placeId?: string;
  open?: (target: SettingsEditorTarget) => Promise<string | undefined>;
  preview?: (target: SettingsPreviewTarget) => void;
}>({ configured: false });

// read the nearest workspace's configured-editor launch action
export const useSettingsTerminalEditor = () => useContext(SettingsTerminalEditorContext);
