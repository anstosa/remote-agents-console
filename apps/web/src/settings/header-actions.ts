import { createContext } from 'react';

// mount file actions inside the owning split's existing header toolbar
export const SettingsHeaderActionsContext = createContext<HTMLElement | null>(null);
