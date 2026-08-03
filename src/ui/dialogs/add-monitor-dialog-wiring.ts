import type { MonType } from '../types';

export function syncRailToSection(addDialog: HTMLElement, step: string): void {
  addDialog.querySelectorAll<HTMLElement>('#add-rail .rail-step[data-step]').forEach((r) => {
    r.classList.toggle('active', r.dataset.step === step);
  });
}

export function wireAddDialogRail(
  addDialog: HTMLElement,
  onTypeSelect: (type: MonType) => void,
  syncFields: (t?: MonType) => void,
): void {
  addDialog.querySelector('.dialog-body')?.addEventListener('scroll', function (this: HTMLElement) {
    const top = this.scrollTop;
    const sections = addDialog.querySelectorAll<HTMLElement>('.form-section[data-section]');
    let cur = sections[0]?.dataset.section ?? 'type';
    for (const s of sections) {
      if (s.offsetTop - this.offsetTop - 20 <= top) cur = s.dataset.section ?? cur;
    }
    syncRailToSection(addDialog, cur);
  });

  addDialog.querySelectorAll<HTMLElement>('#add-rail .rail-step[data-step]').forEach((r) => {
    r.addEventListener('click', () => {
      const sec = addDialog.querySelector<HTMLElement>(
        `.form-section[data-section="${r.dataset.step}"]`,
      );
      const body = addDialog.querySelector<HTMLElement>('.dialog-body');
      if (sec && body) body.scrollTo({ top: sec.offsetTop - body.offsetTop, behavior: 'smooth' });
      syncRailToSection(addDialog, r.dataset.step ?? 'type');
    });
  });

  const typeGrid = document.getElementById('type-grid');
  typeGrid?.querySelectorAll<HTMLButtonElement>('.type-tile').forEach((tile) => {
    tile.addEventListener('click', () => {
      typeGrid.querySelectorAll('.type-tile').forEach((t) => t.classList.remove('active'));
      tile.classList.add('active');
      const type = (tile.dataset.type ?? 'url') as MonType;
      onTypeSelect(type);
      syncFields(type);
    });
  });

  addDialog.querySelectorAll('[data-close-dialog]').forEach((btn) => {
    btn.addEventListener('click', () => (addDialog as HTMLDialogElement).close());
  });

  addDialog.querySelectorAll<HTMLInputElement>('input[type="number"]').forEach((el) => {
    el.addEventListener('focus', () => el.select());
  });
}
