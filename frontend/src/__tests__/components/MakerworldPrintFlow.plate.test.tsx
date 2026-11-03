/** Bambu's API gives no link: the flow asks the phone app for the plate, then runs again. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { MakerworldPrintFlow } from '../../components/MakerworldPrintFlow';
import { api } from '../../api/client';

const blocked = (job_id: number) => ({
  job_id,
  status: 'completed',
  result: { block: 'needs_device_download', block_detail: 'No link from Bambu', model_id: 5, instance_id: 7 },
});

describe('MakerworldPrintFlow plate fetch', () => {
  beforeEach(() => {
    let job = 0;
    vi.spyOn(api, 'startMakerworldPrint').mockImplementation(async () => ({ job_id: ++job }) as never);
    vi.spyOn(api, 'getSliceJob').mockImplementation(async (id: number) => blocked(id) as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete window.BambuddyHandyApp;
  });

  const open = () => render(<MakerworldPrintFlow url="https://makerworld.com/models/5" onClose={() => {}} />);

  it('asks the app once, retries, and stops if the plate still has no link', async () => {
    const fetchPlate = vi.fn();
    window.BambuddyHandyApp = { closeFlow: vi.fn(), fetchPlate };
    open();
    await waitFor(() => expect(fetchPlate).toHaveBeenCalledWith('5', '7', expect.any(String)));

    window.BambuddyHandyPlateResult?.(null);
    await waitFor(() => expect(api.startMakerworldPrint).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('No link from Bambu')).toBeInTheDocument();
    expect(fetchPlate).toHaveBeenCalledTimes(1);
  });

  it("shows the app's error", async () => {
    const fetchPlate = vi.fn();
    window.BambuddyHandyApp = { closeFlow: vi.fn(), fetchPlate };
    open();
    await waitFor(() => expect(fetchPlate).toHaveBeenCalled());
    window.BambuddyHandyPlateResult?.('Sign in to MakerWorld');
    expect(await screen.findByText('Sign in to MakerWorld')).toBeInTheDocument();
    expect(api.startMakerworldPrint).toHaveBeenCalledTimes(1);
  });

  it("shows the server's message outside the app", async () => {
    open();
    expect(await screen.findByText('No link from Bambu')).toBeInTheDocument();
  });
});
