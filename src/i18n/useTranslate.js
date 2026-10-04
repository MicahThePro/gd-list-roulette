import { useCallback, useEffect, useState } from 'react'
import { getLanguage, subscribeToLanguage, translate } from './i18n.js'

/**
 * The current language, and the function components use to read a string.
 *
 * A thin wrapper over the module store rather than context, for the reasons in
 * i18n.js: any component can call `t` without being handed anything, and a change
 * to the language re-renders every subscriber from the top. The App re-renders on
 * a subscription of its own, so nothing below it has to.
 *
 * Every subscriber re-rendering on a change is deliberate. It costs a full repaint
 * on a click the player makes a handful of times per visit, and buys the
 * guarantee that there is no screen which kept the old language because it
 * happened not to be under the one provider that re-rendered.
 */
export const useTranslate = () => {
  const [language, setLanguageState] = useState(getLanguage)

  useEffect(() => subscribeToLanguage(setLanguageState), [])

  const t = useCallback((key, values) => translate(key, values), [language])

  return { language, t }
}
