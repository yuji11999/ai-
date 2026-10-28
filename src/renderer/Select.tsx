import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { enabledOptionIndex, matchingOptionIndex, selectMenuPosition, type SelectMenuPosition, type SelectOption } from './select-utils';

type Props = { id: string; value: string; options: SelectOption[]; onChange: (value: string) => void;
  disabled?: boolean; compact?: boolean; title?: string; menuMinWidth?: number };

export function Select({ id, value, options, onChange, disabled = false, compact = false, title, menuMinWidth = 180 }: Props) {
  const uid = useId();
  const listId = `select-list-${uid}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef({ text: '', time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<SelectMenuPosition | null>(null);
  const selected = options.find(option => option.value === value);

  const start = (direction: 1 | -1 = 1) => {
    if (disabled) return;
    const current = options.findIndex(option => option.value === value && !option.disabled);
    setActive(current >= 0 ? current : enabledOptionIndex(options, direction === 1 ? 0 : options.length - 1, direction));
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  };
  const move = (direction: 1 | -1) => {
    const startIndex = active < 0 ? (direction === 1 ? 0 : options.length - 1) : active + direction;
    const next = enabledOptionIndex(options, startIndex, direction);
    if (next >= 0) setActive(next);
  };
  const keyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
    if (event.key === 'Tab') { setOpen(false); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      if (open) move(direction); else start(direction);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const direction = event.key === 'Home' ? 1 : -1;
      const next = enabledOptionIndex(options, direction === 1 ? 0 : options.length - 1, direction);
      if (next >= 0) { setActive(next); setOpen(true); }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(active); else start();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const now = Date.now();
      const term = now - search.current.time < 700 ? search.current.text + event.key : event.key;
      search.current = { text: term, time: now };
      const current = open ? active : options.findIndex(option => option.value === value);
      let next = matchingOptionIndex(options, term, current);
      if (next < 0 && term.length > 1 && [...term].every(character => character.toLocaleLowerCase() === event.key.toLocaleLowerCase())) {
        next = matchingOptionIndex(options, event.key, current);
        search.current.text = event.key;
      }
      if (next >= 0) { event.preventDefault(); setActive(next); setOpen(true); }
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const menu = list.current;
      const measuredHeight = menu ? menu.scrollHeight + menu.offsetHeight - menu.clientHeight : undefined;
      const next = selectMenuPosition(rect, { width: window.innerWidth, height: window.innerHeight }, options.length, menuMinWidth, measuredHeight);
      setPosition(current => current && current.left === next.left && current.top === next.top && current.width === next.width && current.maxHeight === next.maxHeight ? current : next);
    };
    update();
    const outside = (event: PointerEvent) => { const target = event.target as Node; if (!trigger.current?.contains(target) && !list.current?.contains(target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const observer = list.current ? new ResizeObserver(update) : null;
    if (list.current) observer?.observe(list.current);
    return () => { observer?.disconnect(); document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [open, options, menuMinWidth, position?.width]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    if (!options[active] || options[active].disabled) setActive(enabledOptionIndex(options, 0, 1));
  }, [open, active, options]);
  useEffect(() => {
    if (!open || active < 0) return;
    const menu = list.current, item = menu?.children[active] as HTMLElement | undefined;
    if (!menu || !item) return;
    const bounds = menu.getBoundingClientRect(), itemBounds = item.getBoundingClientRect();
    if (itemBounds.top < bounds.top) menu.scrollTop -= bounds.top - itemBounds.top;
    else if (itemBounds.bottom > bounds.bottom) menu.scrollTop += itemBounds.bottom - bounds.bottom;
  }, [open, active, position]);

  return <>
    <button ref={trigger} id={id} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined} className={`select-trigger ${compact ? 'select-trigger--compact' : 'select-trigger--field'}`} title={title} disabled={disabled} onClick={() => open ? setOpen(false) : start()} onKeyDown={keyDown} onBlur={() => setOpen(false)}>
      <span className="select-value">{selected?.label ?? '请选择'}</span><svg className="select-chevron" viewBox="0 0 12 8" fill="none" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" stroke="currentColor" strokeWidth="1.5" /></svg>
    </button>
    {open && position && createPortal(<div ref={list} id={listId} role="listbox" aria-label={trigger.current?.labels?.[0]?.textContent ?? '选项'} className="select-menu" style={position}>{options.map((option, index) => <div key={`${option.value}:${index}`} id={`${listId}-${index}`} role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined} title={option.title} className={`select-option ${index === active ? 'is-active' : ''} ${option.value === value ? 'is-selected' : ''} ${option.disabled ? 'is-disabled' : ''}`} onMouseDown={event => event.preventDefault()} onMouseMove={() => { if (!option.disabled) setActive(index); }} onClick={() => choose(index)}><span>{option.label}</span>{option.value === value && <span className="select-check" aria-hidden="true">✓</span>}</div>)}</div>, trigger.current?.closest<HTMLElement>('[role="dialog"]') ?? document.body)}
  </>;
}
