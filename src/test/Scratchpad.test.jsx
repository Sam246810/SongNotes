import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Toolbar from '../components/Toolbar/Toolbar';
import DAWPanel from '../components/DAWPanel/DAWPanel';

beforeEach(() => {
  window.AudioContext = function MockAudioContext() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
    this.createGain = () => ({
      gain: { value: 1, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: () => {},
      disconnect: () => {},
    });
    this.createOscillator = () => ({
      frequency: { setValueAtTime: () => {} },
      setPeriodicWave: () => {},
      connect: () => {},
      start: () => {},
      stop: () => {},
    });
    this.createPeriodicWave = () => ({});
    this.createBuffer = () => ({ getChannelData: () => new Float32Array(100) });
    this.resume = async () => {};
  };
});

describe('Scratchpad UI Integration', () => {
  const dummySong = { id: '1', title: 'Test Song', locked: false, lines: [] };

  it('renders unified Scratchpad toggle button in Toolbar', () => {
    render(
      <Toolbar
        song={dummySong}
        sidebarOpen={true}
        onToggleSidebar={() => {}}
        showScratchpad={false}
        onToggleScratchpad={() => {}}
      />
    );
    const scratchpadBtn = screen.getByRole('button', { name: /Scratchpad/i });
    expect(scratchpadBtn).toBeTruthy();
    expect(scratchpadBtn.textContent).toContain('Scratchpad');
  });

  it('calls onToggleScratchpad when toolbar Scratchpad button is clicked', async () => {
    const user = userEvent.setup();
    const handleToggle = vi.fn();
    render(
      <Toolbar
        song={dummySong}
        sidebarOpen={true}
        onToggleSidebar={() => {}}
        showScratchpad={false}
        onToggleScratchpad={handleToggle}
      />
    );
    const scratchpadBtn = screen.getByRole('button', { name: /Scratchpad/i });
    await user.click(scratchpadBtn);
    expect(handleToggle).toHaveBeenCalledTimes(1);
  });

  it('renders DAW and Piano sub-toggle buttons inside Scratchpad panel header', () => {
    render(
      <DAWPanel
        showDaw={true}
        onToggleDaw={() => {}}
        showPiano={true}
        onTogglePiano={() => {}}
      />
    );
    const dawSubBtn = screen.getByTitle('Hide DAW Tracks');
    const pianoSubBtn = screen.getByTitle('Hide Piano Keyboard');
    expect(dawSubBtn).toBeTruthy();
    expect(pianoSubBtn).toBeTruthy();
  });

  it('shows empty state message when both DAW and Piano are hidden inside Scratchpad', () => {
    render(
      <DAWPanel
        showDaw={false}
        onToggleDaw={() => {}}
        showPiano={false}
        onTogglePiano={() => {}}
      />
    );
    expect(screen.getByText(/Scratchpad tools hidden/i)).toBeTruthy();
  });

  it('keeps Metronome and transport controls visible even when DAW tracks are hidden (showDaw=false)', () => {
    render(
      <DAWPanel
        showDaw={false}
        onToggleDaw={() => {}}
        showPiano={false}
        onTogglePiano={() => {}}
      />
    );
    // Metronome button and BPM input should still be rendered in Scratchpad header
    expect(screen.getByTitle('Toggle Metronome')).toBeTruthy();
    expect(screen.getByTitle('Metronome BPM (40-240)')).toBeTruthy();
    // Multitrack timeline ruler corner should NOT be rendered when showDaw is false
    expect(screen.queryByText('Track Controls')).toBeNull();
  });

  it('shows DAW multitrack timeline ruler when showDaw is true', () => {
    render(
      <DAWPanel
        showDaw={true}
        onToggleDaw={() => {}}
        showPiano={false}
        onTogglePiano={() => {}}
      />
    );
    expect(screen.getByText('Track Controls')).toBeTruthy();
  });

  it('renders Export Audio dropdown and does NOT render the removed Expand button', () => {
    render(
      <DAWPanel
        showDaw={true}
        onToggleDaw={() => {}}
        showPiano={false}
        onTogglePiano={() => {}}
      />
    );
    expect(screen.getByTitle(/Export recorded audio/i)).toBeTruthy();
    expect(screen.queryByTitle(/Expand Panel Width|Collapse Panel Width/i)).toBeNull();
  });

  it('allows only one track to be soloed at a time', async () => {
    const user = userEvent.setup();
    render(
      <DAWPanel
        showDaw={true}
        onToggleDaw={() => {}}
        showPiano={false}
        onTogglePiano={() => {}}
      />
    );
    const soloButtons = screen.getAllByTitle('Solo Track');
    expect(soloButtons.length).toBeGreaterThan(1);

    // Click solo on first track
    await user.click(soloButtons[0]);
    expect(soloButtons[0].className).toContain('active');

    // Click solo on second track
    await user.click(soloButtons[1]);
    expect(soloButtons[1].className).toContain('active');
    expect(soloButtons[0].className).not.toContain('active');
  });
});
