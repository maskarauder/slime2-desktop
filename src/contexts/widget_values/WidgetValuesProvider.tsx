import type { WidgetSettings } from '@/helpers/json/widgetSettings';
import {
	loadWidgetValues,
	saveWidgetValues,
	type WidgetValues,
} from '@/helpers/json/widgetValues';
import { sendWidgetValues } from '@/helpers/widgetMessage';
import type { AppliedWidgetUpdate } from '@/helpers/widgetUpdater';
import {
	isWidgetUpdating,
	widgetUpdateGeneration,
} from '@/helpers/widgetUpdateState';
import { useEffect, useReducer, useState } from 'react';
import { WidgetValuesContext } from './useWidgetValues';
import {
	WidgetValuesDispatchContext,
	widgetValuesReducer,
} from './useWidgetValuesDispatch';

type WidgetValuesProviderProps = {
	id: string;
	settings: WidgetSettings;
};

export default function WidgetValuesProvider({
	children,
	settings,
	id,
}: Props.WithChildren<WidgetValuesProviderProps>) {
	const [widgetValues, dispatch] = useReducer(widgetValuesReducer, {});
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let active = true;
		const generation = widgetUpdateGeneration(id);
		async function getWidgetValues() {
			const values = await loadWidgetValues(id);
			if (!active || widgetUpdateGeneration(id) !== generation) return;
			dispatch({ type: 'replace', values });
			setLoading(false);
		}

		getWidgetValues();
		return () => {
			active = false;
		};
	}, [id]);

	useEffect(() => {
		function updated(event: CustomEventInit<AppliedWidgetUpdate>) {
			const widget = event.detail?.widgets.find(w => w.widgetId === id);
			if (!widget) return;
			dispatch({ type: 'replace', values: widget.values });
			setLoading(false);
		}
		addEventListener('widget-update-applied', updated);
		return () => removeEventListener('widget-update-applied', updated);
	}, [id]);

	useEffect(() => {
		function updateValuesListener(
			event: CustomEventInit<{
				widget_id: string;
				values: WidgetValues;
			}>,
		) {
			if (
				!event.detail ||
				event.detail.widget_id !== id ||
				isWidgetUpdating(id)
			)
				return;
			const { values } = event.detail;
			dispatch({ type: 'set-multiple', values });
		}

		addEventListener('update-values', updateValuesListener);

		return () => {
			removeEventListener('update-values', updateValuesListener);
		};
	}, []);

	// send and save on every widgetValue change after load
	useEffect(() => {
		if (
			!loading &&
			!isWidgetUpdating(id) &&
			Object.keys(settings).length > 0
		) {
			sendWidgetValues(id, settings, widgetValues);
			saveWidgetValues(id, widgetValues);
		}
	}, [widgetValues, loading, settings]);

	return (
		<WidgetValuesContext value={widgetValues}>
			<WidgetValuesDispatchContext value={dispatch}>
				{children}
			</WidgetValuesDispatchContext>
		</WidgetValuesContext>
	);
}
