import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChordTokenDisplay from '../components/ChordTokenDisplay/ChordTokenDisplay';

// Note: CSS Modules return empty objects in jsdom so we test DOM structure and behaviour.

describe('ChordTokenDisplay', () => {
  it('renders nothing visible when value is empty', () => {
    const { container } = render(<ChordTokenDisplay value="" onClick={() => {}} />);
    // Should have the display wrapper but no visible text
    expect(container.firstChild).toBeTruthy();
    expect(container.textContent.trim()).toBe('');
  });

  it('renders known chords as visible text', () => {
    render(<ChordTokenDisplay value="Am G C" onClick={() => {}} />);
    expect(screen.getByText('Am')).toBeTruthy();
    expect(screen.getByText('G')).toBeTruthy();
    expect(screen.getByText('C')).toBeTruthy();
  });

  it('renders unknown chord-like tokens as visible text (not invisible)', () => {
    render(<ChordTokenDisplay value="Am9 Am" onClick={() => {}} />);
    // Am9 is NOT in the chord DB — but it must still appear in the document
    expect(screen.getByText('Am9')).toBeTruthy();
  });

  it('calls onClick when the container is clicked (and not locked)', async () => {
    const user = userEvent.setup();
    let clicked = false;
    const { container } = render(
      <ChordTokenDisplay value="Am" onClick={() => { clicked = true; }} locked={false} />
    );
    await user.click(container.firstChild);
    expect(clicked).toBe(true);
  });

  it('does NOT call onClick when locked', async () => {
    const user = userEvent.setup();
    let clicked = false;
    const { container } = render(
      <ChordTokenDisplay value="Am" onClick={() => { clicked = true; }} locked={true} />
    );
    await user.click(container.firstChild);
    expect(clicked).toBe(false);
  });

  it('shows chord diagram popup on hover for known chords', async () => {
    const user = userEvent.setup();
    render(<ChordTokenDisplay value="Am" onClick={() => {}} />);
    const amSpan = screen.getByText('Am');
    await user.hover(amSpan);
    // The chord diagram should appear in the portal (document.body)
    await waitFor(() => {
      // ChordDiagram renders the chord name inside the popup
      const popupNames = document.body.querySelectorAll('[class*="chordName"]');
      expect(popupNames.length).toBeGreaterThan(0);
    });
  });

  it('shows "no chord chart" popup on hover for unknown tokens', async () => {
    const user = userEvent.setup();
    render(<ChordTokenDisplay value="Am9" onClick={() => {}} />);
    const am9Span = screen.getByText('Am9');
    await user.hover(am9Span);
    // Should see the no-chart message in the portal
    await waitFor(() => {
      expect(document.body.textContent).toContain('no chord chart for this chord yet');
    });
  });

  it('hides diagram after mouse leaves', async () => {
    const user = userEvent.setup();
    render(<ChordTokenDisplay value="Am" onClick={() => {}} />);
    const amSpan = screen.getByText('Am');
    await user.hover(amSpan);
    await user.unhover(amSpan);
    // After the 80ms debounce, popup should disappear
    await waitFor(
      () => {
        const popupNames = document.body.querySelectorAll('[class*="chordName"]');
        expect(popupNames.length).toBe(0);
      },
      { timeout: 500 }
    );
  });

  describe('custom voicings', () => {
    it('uses a customChords entry instead of the "no chart" fallback', async () => {
      const user = userEvent.setup();
      const customChords = { Am9: { frets: [-1, 0, 2, 0, 1, 0], baseFret: 1 } };
      render(<ChordTokenDisplay value="Am9" onClick={() => {}} customChords={customChords} />);
      await user.hover(screen.getByText('Am9'));
      await waitFor(() => {
        expect(document.body.textContent).not.toContain('no chord chart for this chord yet');
        expect(document.body.querySelectorAll('[class*="chordName"]').length).toBeGreaterThan(0);
      });
    });

    it('shows an "Add voicing" affordance for an unrecognized chord when onSaveVoicing is provided', async () => {
      const user = userEvent.setup();
      render(<ChordTokenDisplay value="Am9" onClick={() => {}} onSaveVoicing={() => {}} />);
      await user.hover(screen.getByText('Am9'));
      await waitFor(() => {
        expect(screen.getByText('+ Add voicing')).toBeTruthy();
      });
    });

    it('does not show voicing-editing controls when locked', async () => {
      const user = userEvent.setup();
      render(<ChordTokenDisplay value="Am9" onClick={() => {}} onSaveVoicing={() => {}} locked />);
      await user.hover(screen.getByText('Am9'));
      await waitFor(() => {
        expect(document.body.textContent).toContain('no chord chart for this chord yet');
      });
      expect(screen.queryByText('+ Add voicing')).toBeNull();
    });

    it('saving a typed voicing calls onSaveVoicing with the normalized chord name and parsed frets', async () => {
      const user = userEvent.setup();
      const saved = [];
      render(
        <ChordTokenDisplay
          value="Am9"
          onClick={() => {}}
          onSaveVoicing={(name, voicing) => saved.push([name, voicing])}
        />
      );
      await user.hover(screen.getByText('Am9'));
      await waitFor(() => expect(screen.getByText('+ Add voicing')).toBeTruthy());
      await user.click(screen.getByText('+ Add voicing'));

      const input = await screen.findByPlaceholderText('x 3 2 0 1 0');
      await user.clear(input);
      await user.type(input, 'x 0 2 0 1 0');
      await user.click(screen.getByText('Save'));

      expect(saved).toEqual([['Am9', { frets: [-1, 0, 2, 0, 1, 0], baseFret: 1 }]]);
    });

    it('the editor stays open across a brief mouse-leave (does not discard unsaved input)', async () => {
      const user = userEvent.setup();
      render(<ChordTokenDisplay value="Am9" onClick={() => {}} onSaveVoicing={() => {}} />);
      const tokenSpan = screen.getByText('Am9'); // capture before the popup adds its own "Am9" text
      await user.hover(tokenSpan);
      await waitFor(() => expect(screen.getByText('+ Add voicing')).toBeTruthy());
      await user.click(screen.getByText('+ Add voicing'));
      await screen.findByPlaceholderText('x 3 2 0 1 0');

      // Mouse leaves the token entirely, as it would while reaching for the popup below it.
      await user.unhover(tokenSpan);
      await new Promise((r) => setTimeout(r, 150)); // past the 80ms hide debounce

      expect(screen.getByPlaceholderText('x 3 2 0 1 0')).toBeTruthy();
    });
  });
});
