/** Extend upstream math syntax with TeX delimiters and price-safe single-dollar inline math, reusing its token vocabulary. */

import { factorySpace } from 'micromark-factory-space'
import type {} from 'micromark-extension-math'
import { asciiDigit, markdownLineEnding, markdownLineEndingOrSpace, unicodeWhitespace } from 'micromark-util-character'
import { codes, constants, types } from 'micromark-util-symbol'
import type { Construct, Extension, Previous, State, Tokenizer } from 'micromark-util-types'

// oxlint-disable typescript/no-this-alias -- micromark binds tokenizer context only on the outer callback.

/** A text construct on `marker` may not start right after an unescaped `marker`. */
function previousUnescaped(marker: number): Previous {
  return function (code) {
    if (code !== marker) return true
    const tail = this.events.at(-1)
    /* v8 ignore next -- a previous code necessarily has a preceding event. */
    if (tail === undefined) return false
    return tail[1].type === types.characterEscape
  }
}

const tokenizeBackslashMathText: Tokenizer = function (effects, ok, nok) {
  return start

  function start(code: number | null): State | undefined {
    /* v8 ignore next -- the text construct is dispatched only for a backslash. */
    if (code !== codes.backslash) return nok(code)
    effects.enter('mathText')
    effects.enter('mathTextSequence')
    effects.consume(code)
    return open
  }

  function open(code: number | null): State | undefined {
    if (code !== codes.leftParenthesis) return nok(code)
    effects.consume(code)
    effects.exit('mathTextSequence')
    return between
  }

  function between(code: number | null): State | undefined {
    if (code === codes.eof) return nok(code)
    if (code === codes.backslash) {
      return effects.attempt({ partial: true, tokenize: tokenizeClose }, close, afterCloseAttempt)(code)
    }
    if (markdownLineEnding(code)) {
      effects.enter(types.lineEnding)
      effects.consume(code)
      effects.exit(types.lineEnding)
      return between
    }
    return dataStart(code)
  }

  function afterCloseAttempt(code: number | null): State | undefined {
    return effects.check({ partial: true, tokenize: tokenizeOpen }, nok, dataStart)(code)
  }

  function dataStart(code: number | null): State | undefined {
    effects.enter('mathTextData')
    effects.consume(code)
    return code === codes.backslash ? afterDataBackslash : data
  }

  function afterDataBackslash(code: number | null): State | undefined {
    if (code === codes.backslash) {
      effects.consume(code)
      return data
    }
    return data(code)
  }

  function data(code: number | null): State | undefined {
    if (code === codes.eof || code === codes.backslash || markdownLineEnding(code)) {
      effects.exit('mathTextData')
      return between(code)
    }
    effects.consume(code)
    return data
  }

  function close(code: number | null): State | undefined {
    effects.exit('mathText')
    return ok(code)
  }

  function tokenizeClose(closeEffects: Parameters<Tokenizer>[0], closeOk: State, closeNok: State): State {
    return slash

    function slash(code: number | null): State | undefined {
      /* v8 ignore next -- this partial construct is attempted only at a backslash. */
      if (code !== codes.backslash) return closeNok(code)
      closeEffects.enter('mathTextSequence')
      closeEffects.consume(code)
      return parenthesis
    }

    function parenthesis(code: number | null): State | undefined {
      if (code !== codes.rightParenthesis) return closeNok(code)
      closeEffects.consume(code)
      closeEffects.exit('mathTextSequence')
      return closeOk
    }
  }

  function tokenizeOpen(openEffects: Parameters<Tokenizer>[0], openOk: State, openNok: State): State {
    return slash

    function slash(code: number | null): State | undefined {
      /* v8 ignore next -- the opening check follows a failed close attempt at a backslash. */
      if (code !== codes.backslash) return openNok(code)
      openEffects.enter(types.chunkString)
      openEffects.consume(code)
      return parenthesis
    }

    function parenthesis(code: number | null): State | undefined {
      if (code !== codes.leftParenthesis) return openNok(code)
      openEffects.consume(code)
      openEffects.exit(types.chunkString)
      return openOk
    }
  }
}

function whitespace(code: number | null): boolean {
  return markdownLineEndingOrSpace(code) || unicodeWhitespace(code)
}

/**
 * Single-dollar inline math under Pandoc's `tex_math_dollars` rule: the
 * opening `$` is followed by a character that is neither whitespace nor `$`,
 * and the closing `$` follows a non-whitespace character, is not part of a
 * longer `$` run, and is not followed by a digit. A `$` inside the span that
 * cannot close it (other than one escaped by an odd backslash run) rejects
 * the span, so `$5 and $x$` keeps `$5 and ` as text.
 */
const tokenizeDollarMathText: Tokenizer = function (effects, ok, nok) {
  let previous: number | null = codes.dollarSign
  let oddBackslashRun = false

  return start

  function start(code: number | null): State | undefined {
    /* v8 ignore next -- the text construct is dispatched only for a dollar sign. */
    if (code !== codes.dollarSign) return nok(code)
    effects.enter('mathText')
    effects.enter('mathTextSequence')
    effects.consume(code)
    effects.exit('mathTextSequence')
    return open
  }

  function open(code: number | null): State | undefined {
    if (code === codes.eof || code === codes.dollarSign || whitespace(code)) return nok(code)
    return between(code)
  }

  function between(code: number | null): State | undefined {
    if (code === codes.eof) return nok(code)
    if (code === codes.dollarSign) {
      if (whitespace(previous)) return nok(code)
      effects.enter('mathTextSequence')
      effects.consume(code)
      effects.exit('mathTextSequence')
      return afterClose
    }
    if (markdownLineEnding(code)) {
      effects.enter(types.lineEnding)
      effects.consume(code)
      effects.exit(types.lineEnding)
      previous = code
      oddBackslashRun = false
      return between
    }
    effects.enter('mathTextData')
    return data(code)
  }

  function data(code: number | null): State | undefined {
    if (code === codes.eof || (code === codes.dollarSign && !oddBackslashRun) || markdownLineEnding(code)) {
      effects.exit('mathTextData')
      return between(code)
    }
    oddBackslashRun = code === codes.backslash ? !oddBackslashRun : false
    previous = code
    effects.consume(code)
    return data
  }

  function afterClose(code: number | null): State | undefined {
    if (code === codes.dollarSign || asciiDigit(code)) return nok(code)
    effects.exit('mathText')
    return ok(code)
  }
}

function createMathFlow(marker: number, openMarker: number, closeMarker: number, multiline: boolean): Construct {
  const tokenize: Tokenizer = function (effects, ok, nok) {
    const self = this
    let oddBackslashRun = false
    const tail = self.events.at(-1)
    const initialSize = tail?.[1].type === types.linePrefix
      ? tail[2].sliceSerialize(tail[1], true).length
      : 0

    return start

    function start(code: number | null): State | undefined {
      /* v8 ignore next -- the flow construct is dispatched only for its marker. */
      if (code !== marker) return nok(code)
      effects.enter('mathFlow')
      effects.enter('mathFlowFence')
      effects.enter('mathFlowFenceSequence')
      effects.consume(code)
      return open
    }

    function open(code: number | null): State | undefined {
      if (code !== openMarker) return nok(code)
      effects.consume(code)
      effects.exit('mathFlowFenceSequence')
      effects.exit('mathFlowFence')
      return marker === codes.dollarSign ? afterDollarOpen : content
    }

    function afterDollarOpen(code: number | null): State | undefined {
      return code === codes.dollarSign ? nok(code) : content(code)
    }

    function content(code: number | null): State | undefined {
      if (code === codes.eof) return nok(code)
      if (code === marker && (marker !== codes.dollarSign || !oddBackslashRun)) {
        return effects.attempt(
          { partial: true, tokenize: tokenizeClosingFence },
          closed,
          afterClosingFenceAttempt,
        )(code)
      }
      if (markdownLineEnding(code)) {
        return multiline
          ? effects.attempt(nonLazyContinuation, afterContinuation, nok)(code)
          : nok(code)
      }
      return valueStart(code)
    }

    function afterClosingFenceAttempt(code: number | null): State | undefined {
      return marker === codes.backslash
        ? effects.check({ partial: true, tokenize: tokenizeOpeningFence }, nok, markerValueStart)(code)
        : markerValueStart(code)
    }

    function afterContinuation(code: number | null): State | undefined {
      return effects.attempt(
        { partial: true, tokenize: tokenizeClosingFence },
        closed,
        initialSize
          ? factorySpace(effects, content, types.linePrefix, initialSize + 1)
          : content,
      )(code)
    }

    function valueStart(code: number | null): State | undefined {
      effects.enter('mathFlowValue')
      oddBackslashRun = code === codes.backslash
      effects.consume(code)
      return value
    }

    function markerValueStart(code: number | null): State | undefined {
      effects.enter('mathFlowValue')
      oddBackslashRun = false
      effects.consume(code)
      return valueAfterMarker
    }

    function valueAfterMarker(code: number | null): State | undefined {
      if (code === marker) {
        effects.consume(code)
        return value
      }
      return value(code)
    }

    function value(code: number | null): State | undefined {
      if (code === codes.eof || code === marker || markdownLineEnding(code)) {
        effects.exit('mathFlowValue')
        return content(code)
      }
      oddBackslashRun = code === codes.backslash ? !oddBackslashRun : false
      effects.consume(code)
      return value
    }

    function closed(code: number | null): State | undefined {
      effects.exit('mathFlow')
      return ok(code)
    }

    function tokenizeClosingFence(
      closeEffects: Parameters<Tokenizer>[0],
      closeOk: State,
      closeNok: State,
    ): State {
      return factorySpace(closeEffects, sequenceStart, types.linePrefix, constants.tabSize)

      function sequenceStart(code: number | null): State | undefined {
        if (code !== marker) return closeNok(code)
        closeEffects.enter('mathFlowFence')
        closeEffects.enter('mathFlowFenceSequence')
        closeEffects.consume(code)
        return sequenceEnd
      }

      function sequenceEnd(code: number | null): State | undefined {
        if (code !== closeMarker) return closeNok(code)
        closeEffects.consume(code)
        closeEffects.exit('mathFlowFenceSequence')
        return factorySpace(closeEffects, after, types.whitespace)
      }

      function after(code: number | null): State | undefined {
        if (code !== codes.eof && !markdownLineEnding(code)) return closeNok(code)
        closeEffects.exit('mathFlowFence')
        return closeOk(code)
      }
    }

    function tokenizeOpeningFence(
      openEffects: Parameters<Tokenizer>[0],
      openOk: State,
      openNok: State,
    ): State {
      return sequenceStart

      function sequenceStart(code: number | null): State | undefined {
        /* v8 ignore next -- the opening check follows a failed close attempt at the marker. */
        if (code !== marker) return openNok(code)
        openEffects.enter(types.chunkString)
        openEffects.consume(code)
        return sequenceEnd
      }

      function sequenceEnd(code: number | null): State | undefined {
        if (code !== openMarker) return openNok(code)
        openEffects.consume(code)
        openEffects.exit(types.chunkString)
        return openOk
      }
    }
  }

  return {
    concrete: true,
    name: marker === codes.dollarSign ? 'sameLineDollarMathFlow' : 'backslashMathFlow',
    tokenize,
  }
}

const tokenizeNonLazyContinuation: Tokenizer = function (effects, ok, nok) {
  const self = this

  return start

  function start(code: number | null): State | undefined {
    /* v8 ignore next -- continuation constructs are attempted only after a line ending. */
    if (code === codes.eof) return ok(code)
    /* v8 ignore next -- continuation constructs are attempted only after a line ending. */
    if (!markdownLineEnding(code)) return nok(code)
    effects.enter(types.lineEnding)
    effects.consume(code)
    effects.exit(types.lineEnding)
    return lineStart
  }

  function lineStart(code: number | null): State | undefined {
    return self.parser.lazy[self.now().line] ? nok(code) : ok(code)
  }
}

const nonLazyContinuation: Construct = {
  partial: true,
  tokenize: tokenizeNonLazyContinuation,
}

const backslashMathText: Construct = {
  name: 'backslashMathText',
  previous: previousUnescaped(codes.backslash),
  tokenize: tokenizeBackslashMathText,
}

const dollarMathText: Construct = {
  name: 'dollarMathText',
  previous: previousUnescaped(codes.dollarSign),
  tokenize: tokenizeDollarMathText,
}

const backslashMathFlow = createMathFlow(
  codes.backslash,
  codes.leftSquareBracket,
  codes.rightSquareBracket,
  true,
)

const sameLineDollarMathFlow = createMathFlow(
  codes.dollarSign,
  codes.dollarSign,
  codes.dollarSign,
  false,
)

const backslashMath: Extension = {
  flow: {
    [codes.backslash]: backslashMathFlow,
    [codes.dollarSign]: sameLineDollarMathFlow,
  },
  text: {
    [codes.backslash]: backslashMathText,
    [codes.dollarSign]: dollarMathText,
  },
}

/**
 * TeX backslash delimiters, same-line display-dollar blocks, and single-dollar
 * inline math that leaves prices such as `$5 or $10` as text, as a micromark
 * syntax extension reusing `micromark-extension-math`'s token vocabulary. The
 * caller must also register `math({ singleDollarTextMath: false })` on the
 * same parse, so the emitted tokens compile to standard math nodes and
 * upstream keeps only the `$$` inline runs this extension declines.
 * @returns The micromark syntax extension.
 */
export function mathCompatibility(): Extension {
  return backslashMath
}
