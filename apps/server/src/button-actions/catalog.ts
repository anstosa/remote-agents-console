import { createHmac, randomBytes } from 'node:crypto';
import { buttonSlotNames, buttonsForSlot, defaultButtons, effectiveButtons, type ButtonSlot, type ConfiguredButton } from '../config/buttons.js';
import type { ValidatedConfig } from '../config/schema.js';

export type ButtonPresentation = Pick<ConfiguredButton, 'text' | 'icon' | 'color' | 'style'> & { id: string; actionKind: 'shell' | 'prompt' };
export type PresentedButtonSlots = Record<ButtonSlot, ButtonPresentation[]>;
export type ButtonCatalog = { revision: string; application: PresentedButtonSlots; projects: Record<string, PresentedButtonSlots> };

// keep executable definitions behind boot-scoped opaque locators
export class ConfiguredButtonCatalog {
  readonly value: ButtonCatalog;
  private readonly definitions = new Map<string, ConfiguredButton>();

  // freeze one validated catalog without publishing executable content hashes
  constructor(config: Pick<ValidatedConfig, 'buttons' | 'projects'>, key: Buffer = randomBytes(32)) {
    const application = config.buttons ?? defaultButtons;
    const revision = createHmac('sha256', key).update('button-catalog\0').update(JSON.stringify([application, config.projects.map(project => [project.id, project.buttons])])).digest('base64url');
    // retain source ownership when an inherited button appears in multiple catalogs
    const present = (project?: typeof config.projects[number]): PresentedButtonSlots => {
      const effective = effectiveButtons(application, project?.buttons);
      return Object.fromEntries(buttonSlotNames.map(slot => {
        const overrides = buttonsForSlot(project?.buttons, slot);
        const defaults = buttonsForSlot(application, slot);
        return [slot, buttonsForSlot(effective, slot).map(button => {
          const overrideIndex = overrides.findIndex(entry => entry.text === button.text);
          const source = overrideIndex < 0 ? ['application', defaults.findIndex(entry => entry.text === button.text)] : ['project', project!.id, overrideIndex];
          const id = createHmac('sha256', key).update('button-action\0').update(JSON.stringify([revision, source, slot])).digest('base64url');
          this.definitions.set(id, structuredClone(button));
          return { id, text: button.text, ...(button.icon === undefined ? {} : { icon: button.icon }), color: button.color, style: button.style, actionKind: 'shellCommand' in button.action ? 'shell' as const : 'prompt' as const };
        })];
      })) as PresentedButtonSlots;
    };
    this.value = { revision, application: present(), projects: Object.fromEntries(config.projects.map(project => [project.id, present(project)])) };
  }

  // authorize a locator against this exact Project and slot before resolving its bytes
  resolve(projectId: string, slot: ButtonSlot, actionId: string, revision: string): ConfiguredButton | undefined {
    // never adopt a stale catalog after restart or settings replacement
    if (revision !== this.value.revision) return undefined;
    const list = (this.value.projects[projectId] ?? this.value.application)[slot];
    // opaque IDs are locators rather than authority
    if (!list.some(button => button.id === actionId)) return undefined;
    const definition = this.definitions.get(actionId);
    return definition === undefined ? undefined : structuredClone(definition);
  }
}
