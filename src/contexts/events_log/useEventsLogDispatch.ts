import {
	saveEventsLog,
	type EventsLog,
	type LoggedEvent,
} from '@@/json/eventsLog';
import { createContext, useContext } from 'react';
import { contextErrorMessage } from '../common';

const MAX_EVENTS_LOG_ENTRIES = 1000;

export function useEventsLogDispatch() {
	const dispatch = useContext(EventsLogDispatchContext);

	if (!dispatch) {
		throw new Error(
			contextErrorMessage('useEventsLogDispatch', 'EventsLogDispatchContext'),
		);
	}

	const logEvent = (id: string, event: LoggedEvent) => {
		dispatch({ type: 'add', id, event });
	};

	return { logEvent };
}

export const EventsLogDispatchContext = createContext<
	React.Dispatch<EventsLogAction> | undefined
>(undefined);

export function eventsLogReducer(
	state: Record<string, EventsLog>,
	action: EventsLogAction,
): Record<string, EventsLog> {
	const newState = { ...state };

	switch (action.type) {
		case 'set': {
			const { id, log } = action;

			// deep copy new data
			const newLog: EventsLog = structuredClone(
				log.slice(-MAX_EVENTS_LOG_ENTRIES),
			);

			// set new events log
			newState[id] = newLog;
			saveEventsLog(id, newLog);
			break;
		}
		case 'add': {
			const { id, event } = action;

			// deep copy new data
			const newEvent: LoggedEvent = structuredClone(event);

			// Keep recent history without cloning unrelated accounts or old payloads.
			newState[id] = [
				...(state[id] || []).slice(-(MAX_EVENTS_LOG_ENTRIES - 1)),
				newEvent,
			];
			saveEventsLog(id, newState[id]);
			break;
		}
	}

	return newState;
}

type EventsLogAction =
	| {
			type: 'set';
			id: string;
			log: EventsLog;
	  }
	| {
			type: 'add';
			id: string;
			event: LoggedEvent;
	  };
