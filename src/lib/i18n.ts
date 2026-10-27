// Extension-page strings, shared by the popup and the warning page. Side-effect free on purpose:
// importing an entry module (warning.ts) would run its main() in the importer.
import de from './i18n/de.json';
import en from './i18n/en.json';
import fr from './i18n/fr.json';
import it from './i18n/it.json';
import nl from './i18n/nl.json';
import uk from './i18n/uk.json';

export type Strings = typeof en;
const ALL: Record<string, Strings> = { en, de, fr, it, nl, uk };
export const stringsFor = (locale: string): Strings => ALL[locale] ?? en;
