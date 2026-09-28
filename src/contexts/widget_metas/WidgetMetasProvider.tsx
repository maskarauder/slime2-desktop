import { loadWidgetMeta } from '@/helpers/json/widgetMeta';
import type { AppliedWidgetUpdate } from '@/helpers/widgetUpdater';
import { widgetUpdateGeneration } from '@/helpers/widgetUpdateState';
import { useCallback, useEffect, useReducer } from 'react';
import useTileLocations from '../tile_locations/useTileLocations';
import { WidgetMetasContext } from './useWidgetMetas';
import {
	WidgetMetasDispatchContext,
	widgetMetasReducer,
} from './useWidgetMetasDispatch';

export default function WidgetMetasProvider({ children }: Props.WithChildren) {
	const locations = useTileLocations();
	const [widgetMetas, dispatch] = useReducer(widgetMetasReducer, {});

	const getWidgetMeta = useCallback(
		async (id: string) => {
			const generation = widgetUpdateGeneration(id);
			const meta = await loadWidgetMeta(id);
			if (widgetUpdateGeneration(id) !== generation) return;
			dispatch({ type: 'set', id, meta });
		},
		[dispatch],
	);

	useEffect(() => {
		async function loadWidgetMetas() {
			const loadPromises: Promise<void>[] = [];

			// loop thru all location ids, loading widget metas
			// if they don't already exist in the widget metas map
			Object.keys(locations).forEach(id => {
				if (id.startsWith('widget_') && !widgetMetas[id]) {
					loadPromises.push(getWidgetMeta(id));
				}
			});

			// simultaneously load widget metas
			await Promise.all(loadPromises);
		}

		loadWidgetMetas();
	}, [locations, widgetMetas]);

	useEffect(() => {
		// remove widgetMeta if widget is deleted
		function updated(event: CustomEventInit<AppliedWidgetUpdate>) {
			for (const widget of event.detail?.widgets ?? [])
				dispatch({
					type: 'hydrate',
					id: widget.widgetId,
					meta: widget.meta,
				});
		}
		addEventListener('widget-update-applied', updated);
		function widgetDeleteListener(
			event: CustomEventInit<{ widgetId: string }>,
		) {
			if (!event.detail?.widgetId) return;
			dispatch({ type: 'delete', id: event.detail.widgetId });
		}

		addEventListener('widget-delete', widgetDeleteListener);

		return () => {
			removeEventListener('widget-update-applied', updated);
			removeEventListener('widget-delete', widgetDeleteListener);
		};
	}, [dispatch]);

	return (
		<WidgetMetasContext value={widgetMetas}>
			<WidgetMetasDispatchContext value={dispatch}>
				{children}
			</WidgetMetasDispatchContext>
		</WidgetMetasContext>
	);
}
