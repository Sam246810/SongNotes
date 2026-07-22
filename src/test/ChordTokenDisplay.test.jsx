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
    render(<ChordTokenDisplay value="D6 Am" onClick={() => {}} />);
    // D6 is NOT in the chord DB — but it must still appear in the document
    expect(screen.getByText('D6')).toBeTruthy();
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
    render(<ChordTokenDisplay value="D6" onClick={() => {}} />);
    const d6Span = screen.getByText('D6');
    await user.hover(d6Span);
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
});
