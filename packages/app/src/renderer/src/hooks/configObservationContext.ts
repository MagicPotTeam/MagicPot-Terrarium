import { createContext, useContext } from 'react'
import { unavailableConfigObservation, type ConfigObservationSource } from './configObservation'

/** Renderer display freshness only. Missing provider is fail-closed, never an API probe. */
const ConfigObservationContext = createContext<ConfigObservationSource>(unavailableConfigObservation)
export const ConfigObservationProvider = ConfigObservationContext.Provider
export function useConfigObservation(): ConfigObservationSource {
  return useContext(ConfigObservationContext)
}
