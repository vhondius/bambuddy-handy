/**
 * Tests for LocalProfilesView component.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, render as rawRender } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { AuthProvider } from '../../contexts/AuthContext';
import { LocalProfilesView } from '../../components/LocalProfilesView';

const mockLocalPresets = {
  filament: [
    {
      id: 1,
      name: 'Overture PLA Matte @BBL X1C',
      preset_type: 'filament',
      source: 'orcaslicer',
      filament_type: 'PLA',
      filament_vendor: 'Overture',
      nozzle_temp_min: 190,
      nozzle_temp_max: 230,
      pressure_advance: '["0.04"]',
      default_filament_colour: '["#FFAA00"]',
      filament_cost: '24.99',
      filament_density: '1.24',
      compatible_printers: '["Bambu Lab X1 Carbon 0.4 nozzle"]',
      inherits: 'Bambu PLA Basic @BBL X1C',
      version: '2.3.0.4',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 2,
      name: 'eSUN PETG @Bambu Lab H2D',
      preset_type: 'filament',
      source: 'orcaslicer',
      filament_type: 'PETG',
      filament_vendor: null,
      nozzle_temp_min: 220,
      nozzle_temp_max: 250,
      pressure_advance: null,
      default_filament_colour: null,
      filament_cost: null,
      filament_density: null,
      compatible_printers: null,
      inherits: null,
      version: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ],
  process: [
    {
      id: 3,
      name: '0.20mm Standard @BBL X1C',
      preset_type: 'process',
      source: 'orcaslicer',
      filament_type: null,
      filament_vendor: null,
      nozzle_temp_min: null,
      nozzle_temp_max: null,
      pressure_advance: null,
      default_filament_colour: null,
      filament_cost: null,
      filament_density: null,
      compatible_printers: null,
      inherits: '0.20mm Standard @BBL X1C',
      version: '2.3.0.4',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ],
  printer: [],
};

describe('LocalProfilesView', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/local-presets/', () => {
        return HttpResponse.json(mockLocalPresets);
      }),
      http.delete('/api/v1/local-presets/:id', () => {
        return HttpResponse.json({ success: true });
      }),
    );
  });

  it('renders filament and process columns', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument();
    });

    expect(screen.getByText('eSUN PETG @Bambu Lab H2D')).toBeInTheDocument();
    expect(screen.getByText('0.20mm Standard @BBL X1C')).toBeInTheDocument();
  });

  it('shows material badges from filament_type', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument();
    });

    // PLA badge should appear for the first preset
    const plaBadges = screen.getAllByText('PLA');
    expect(plaBadges.length).toBeGreaterThan(0);
  });

  it('shows vendor from filament_vendor field', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Overture')).toBeInTheDocument();
    });
  });

  it('parses vendor from name when filament_vendor is null', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('eSUN PETG @Bambu Lab H2D')).toBeInTheDocument();
    });

    // eSUN should be parsed from the name
    expect(screen.getByText('eSUN')).toBeInTheDocument();
  });

  it('filters presets by search query', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/search/i);
    fireEvent.change(searchInput, { target: { value: 'PETG' } });

    expect(screen.queryByText('Overture PLA Matte @BBL X1C')).not.toBeInTheDocument();
    expect(screen.getByText('eSUN PETG @Bambu Lab H2D')).toBeInTheDocument();
  });

  it('keeps the search bar visible when no presets match the query (#1470)', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/search/i);
    fireEvent.change(searchInput, { target: { value: 'zzz-nothing-matches' } });

    // The search bar must stay mounted so the query can be cleared/edited
    // without a page refresh, and it keeps the typed value.
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/search/i)).toHaveValue('zzz-nothing-matches');
    // A no-matches message replaces the columns (not the "import some" empty state).
    expect(screen.getByText(/no presets match your search/i)).toBeInTheDocument();
  });

  it('shows empty state when no presets', async () => {
    server.use(
      http.get('/api/v1/local-presets/', () => {
        return HttpResponse.json({ filament: [], process: [], printer: [] });
      }),
    );

    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText(/no local presets/i)).toBeInTheDocument();
    });
  });

  it('shows Local badge on preset cards', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument();
    });

    const badges = screen.getAllByText(/^Local$/i);
    expect(badges.length).toBeGreaterThan(0);
  });

  it('shows delete confirmation modal', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument();
    });

    // Click first delete button
    const deleteButtons = screen.getAllByTitle(/delete/i);
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(screen.getByText(/are you sure/i)).toBeInTheDocument();
    });
  });

  it('shows import zone', async () => {
    render(<LocalProfilesView />);

    await waitFor(() => {
      expect(screen.getByText(/import profiles/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/\.bbscfg/i)).toBeInTheDocument();
  });

  it('invalidates the slicerPresets query after a delete (#1581)', async () => {
    // Without this invalidation a preset deleted in Local Profiles still
    // shows in the SliceModal until the modal's ['slicerPresets'] query
    // staleTime (60s) expires + a refocus / remount. The bug report:
    // "Removed local profiles still show on the slice menu even tho they
    // have been deleted." We mirror the production provider tree but inject
    // our own QueryClient so we can spy on invalidateQueries.
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    rawRender(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <ThemeProvider>
              <ToastProvider>
                <LocalProfilesView />
              </ToastProvider>
            </ThemeProvider>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument();
    });

    // Open the delete confirmation, then confirm. The card-level delete
    // icon buttons and the modal's Delete button both expose the accessible
    // name "Delete"; the modal button is the last one to mount, so it's the
    // tail of the findAllByRole result.
    const deleteButtons = screen.getAllByTitle(/delete/i);
    fireEvent.click(deleteButtons[0]);
    await screen.findByText(/are you sure/i);
    const confirmButtons = await screen.findAllByRole('button', { name: /^delete$/i });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => {
      expect(
        invalidateSpy.mock.calls.some(
          ([arg]) => arg && (arg as { queryKey: unknown[] }).queryKey?.[0] === 'slicerPresets',
        ),
      ).toBe(true);
    });
    // Sanity: the local-only invalidation is still there too.
    expect(
      invalidateSpy.mock.calls.some(
        ([arg]) => arg && (arg as { queryKey: unknown[] }).queryKey?.[0] === 'localPresets',
      ),
    ).toBe(true);
  });

  describe('editor', () => {
    const detail = {
      ...mockLocalPresets.filament[0],
      setting: {
        name: 'Overture PLA Matte @BBL X1C',
        filament_settings_id: ['Overture PLA Matte @BBL X1C'],
        nozzle_temperature: ['220'],
      },
    };
    let body: Record<string, unknown> | null;

    beforeEach(() => {
      body = null;
      server.use(
        http.get('/api/v1/local-presets/1', () => HttpResponse.json(detail)),
        http.put('/api/v1/local-presets/1', async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(mockLocalPresets.filament[0]);
        }),
        http.post('/api/v1/local-presets/', async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ ...mockLocalPresets.filament[0], id: 9 });
        }),
      );
    });

    const openEditor = async (title: RegExp) => {
      render(<LocalProfilesView />);
      await waitFor(() => expect(screen.getByText('Overture PLA Matte @BBL X1C')).toBeInTheDocument());
      fireEvent.click(screen.getAllByTitle(title)[0]);
      // The JSON tab, once the preset's full setting has loaded.
      return waitFor(() => {
        const el = document.querySelector('textarea');
        expect(el?.value).toContain('nozzle_temperature');
        return el!;
      });
    };

    it('saves JSON edits and keeps the settings id in step with a rename', async () => {
      const json = await openEditor(/^edit$/i);
      fireEvent.change(json, { target: { value: json.value.replace('"220"', '"225"') } });
      fireEvent.change(screen.getByDisplayValue('Overture PLA Matte @BBL X1C'), { target: { value: 'My PLA' } });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(body).not.toBeNull());
      expect(body!.name).toBe('My PLA');
      const setting = body!.setting as Record<string, unknown>;
      expect(setting.nozzle_temperature).toEqual(['225']);
      expect(setting.name).toBe('My PLA');
      expect(setting.filament_settings_id).toEqual(['My PLA']);
    });

    it('blocks saving invalid JSON', async () => {
      const json = await openEditor(/^edit$/i);
      fireEvent.change(json, { target: { value: '{ nope' } });
      expect(screen.getByText(/invalid json/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    });

    it('saves edits as a new preset, leaving the original', async () => {
      const json = await openEditor(/^edit$/i);
      fireEvent.change(json, { target: { value: json.value.replace('"220"', '"230"') } });
      fireEvent.click(screen.getByRole('button', { name: /save as new/i }));

      await waitFor(() => expect(body).not.toBeNull());
      // Only the POST handler records a preset_type: the original was not PUT.
      expect(body).toMatchObject({ name: 'Overture PLA Matte @BBL X1C (Copy)', preset_type: 'filament' });
      expect((body!.setting as Record<string, unknown>).nozzle_temperature).toEqual(['230']);
    });

    it('duplicates as a new preset', async () => {
      await openEditor(/^duplicate$/i);
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(body).not.toBeNull());
      expect(body).toMatchObject({ name: 'Overture PLA Matte @BBL X1C (Copy)', preset_type: 'filament' });
    });
  });
});
