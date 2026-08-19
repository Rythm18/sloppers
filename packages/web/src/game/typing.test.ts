// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { isTypingSomewhere } from './typing.js';

/**
 * The office reads WASD off the window, so it has to know when those letters
 * are somebody filling in a form over the top of it — the settings panel asks
 * for an office name and for your own name before it deletes you, and both
 * are full of the letters that walk.
 */
describe('isTypingSomewhere', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function focus(html: string): HTMLElement {
    document.body.innerHTML = html;
    const element = document.body.firstElementChild;
    if (!(element instanceof HTMLElement)) throw new Error('expected an element to focus');
    element.focus();
    return element;
  }

  it('is false with nothing focused', () => {
    expect(isTypingSomewhere()).toBe(false);
  });

  it('is false on the things you walk with', () => {
    focus('<button type="button">Ban</button>');
    expect(isTypingSomewhere()).toBe(false);
  });

  it('is true in a text field', () => {
    focus('<input aria-label="office name" />');
    expect(isTypingSomewhere()).toBe(true);
  });

  it('is true in a textarea', () => {
    focus('<textarea></textarea>');
    expect(isTypingSomewhere()).toBe(true);
  });

  it('is true in anything editable', () => {
    const editable = focus('<div contenteditable="true"></div>');
    // jsdom does not derive `isContentEditable` from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTypingSomewhere()).toBe(true);
  });
});
