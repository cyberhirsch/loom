/**
 * The worklet's message stream for a project, shared by the live engine and the
 * offline WAV bounce so a bounce plays exactly what live playback plays.
 */

import { mixMessages, routingMessages, type DspMessage } from '../graph/routing';
import { renderTimeline, type BarRender, type TimelineProject } from '../graph/timeline';

/** Messages a transport start sends before the first bar: tempo, phrase length, mix and routing. */
export function sessionMessages(project: TimelineProject): DspMessage[] {
  return [
    { type: 'tempo', bpm: project.conductor.tempo },
    { type: 'steps', value: Number(project.conductor.steps) || 16 },
    ...mixMessages(project.nodes),
    ...routingMessages(project.nodes, project.edges).messages,
  ];
}

/** One timeline bar on the wire, tagged with its bar so the worklet can echo it when it sounds. */
export function barMessage(bar: BarRender, immediate: boolean): DspMessage {
  return { type: 'patterns', absBar: bar.absBar, patterns: bar.patterns, immediate };
}

/** Bars 0..bars-1 played from the top, everything queued before the clock starts, then an
 *  empty bar so the tails ring out instead of the last bar repeating. */
export function bounceMessages(project: TimelineProject, bars: number): DspMessage[] {
  const timeline = renderTimeline(project, 0, Math.max(1, bars));
  return [
    ...sessionMessages(project),
    ...timeline.map((bar, i) => barMessage(bar, i === 0)),
    { type: 'patterns', absBar: timeline.length, patterns: {}, immediate: false },
    { type: 'start' },
  ];
}
