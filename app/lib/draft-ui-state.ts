export type DraftUiState = {
  sourcesOpen: boolean;
  intelligenceLoading: boolean;
  settingsOpen: boolean;
  rawSettingsOpen: boolean;
  strategyOpen: boolean;
  autoWarning: boolean;
};

export const INITIAL_DRAFT_UI_STATE: DraftUiState = {
  sourcesOpen: false,
  intelligenceLoading: true,
  settingsOpen: true,
  rawSettingsOpen: false,
  strategyOpen: false,
  autoWarning: false,
};

export type DraftUiAction =
  | { type: "set"; key: keyof DraftUiState; value: boolean }
  | { type: "toggle"; key: keyof DraftUiState };

export function draftUiReducer(state: DraftUiState, action: DraftUiAction): DraftUiState {
  const value = action.type === "toggle" ? !state[action.key] : action.value;
  return state[action.key] === value ? state : { ...state, [action.key]: value };
}
