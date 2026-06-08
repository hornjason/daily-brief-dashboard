/**
 * Centralized path resolution for config, data, and cache directories.
 *
 * Consolidates 78 independent path resolutions across the codebase into
 * a single source of truth with consistent fallback defaults.
 *
 * GitHub #335 slice 1
 */

import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = (import.meta as any).dir ?? dirname(fileURLToPath(import.meta.url))

// All paths resolve from src/lib/ → ../../ → project root
export const CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(__dir, '../../config')
export const DATA_DIR = process.env.DATA_DIR ?? resolve(__dir, '../../data')
export const CACHE_DIR = process.env.CACHE_DIR ?? resolve(DATA_DIR, 'cache')
export const DATA_CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(DATA_DIR, 'config')
