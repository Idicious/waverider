import type { ScaleLinear, ScaleBand } from "d3";
import * as d3 from "d3";
import { Selection } from "d3-selection";
import {
  Automation,
  AutomationData,
  AutomationPoint,
  BoundData,
  Predicate,
  Renderer,
  WaveShaperState,
} from "../types";
import { BIND_ATTR } from "../bind";
import { ALWAYS } from "../utils";

export const AUTOMATION_HANDLE_RADIUS = 5;

export const TYPES = {
  AUTOMATION: Symbol("automation-group"),
  AUTOMATION_POINT: Symbol("automation-point"),
} as const;

type AutomationBindData = {
  automation: string;
  automationData: string;
  track: string;
  point: AutomationPoint;
};

export class AutomationRenderer implements Renderer {
  #automationMap = new Map<string, Automation>();
  #automationDataMap = new Map<string, AutomationData>();
  #filterFn: Predicate = ALWAYS;

  TYPE = Symbol("automation");

  constructor(
    private readonly trackHeight: number,
    private readonly bindFn: (data: unknown, type: symbol) => string
  ) {}

  onStateUpdate(state: WaveShaperState): void {
    this.#automationMap.clear();
    this.#automationDataMap.clear();

    for (const automation of state.automation) {
      this.#automationMap.set(automation.id, automation);
    }

    for (const automationData of state.automationData) {
      this.#automationDataMap.set(automationData.id, automationData);
    }
  }

  onDragStart(_e: d3.D3DragEvent<any, any, any>, d: BoundData<any>) {
    switch (d.type) {
      case TYPES.AUTOMATION_POINT: {
        this.#filterFn = (data) => data.point.id === d.data.point.id;
        break;
      }
    }
  }

  onDragEnd(_e: d3.D3DragEvent<any, any, any>, d: BoundData<any>) {
    switch (d.type) {
      case TYPES.AUTOMATION_POINT: {
        this.#filterFn = ALWAYS;
        break;
      }
    }
  }

  onDrag(
    e: d3.D3DragEvent<any, any, any>,
    d: BoundData<AutomationBindData>,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>
  ) {
    switch (d.type) {
      case TYPES.AUTOMATION_POINT: {
        this.onDragAutomationPoint(e, d, xScale, yScale);
        break;
      }
    }

    return { type: this.TYPE };
  }

  onBind(
    selection: Selection<any, any, any, any>,
    state: WaveShaperState,
    xScale: ScaleLinear<number, number>,
    yScale: ScaleBand<string>
  ): void {
    const points = state.automationData.flatMap((d) =>
      d.data.map((p) => ({
        automationData: d.id,
        automation: d.automation,
        track: d.track,
        point: p,
      }))
    );

    selection
      .selectAll<Element, AutomationData>(
        `custom.${TYPES.AUTOMATION.description}`
      )
      .filter(() => state.configuration.showAutomation)
      .data(state.automationData, (d) => d.id)
      .join(
        (enter) => {
          return enter
            .append("custom")
            .attr("class", TYPES.AUTOMATION.description!)
            .attr("y", (d) => yScale(d.track)!)
            .attr(BIND_ATTR, (d) => this.bindFn(d, TYPES.AUTOMATION));
        },
        (update) => {
          return update.attr("y", (d) => yScale(d.track)!);
        },
        (remove) => remove.remove()
      );

    selection
      .selectAll<Element, AutomationBindData>(
        `custom.${TYPES.AUTOMATION_POINT.description}`
      )
      .filter(() => state.configuration.showAutomation)
      .data(points, (d) => d.point.id)
      .join(
        (enter) => {
          return enter
            .append("custom")
            .attr("class", TYPES.AUTOMATION_POINT.description!)
            .attr(BIND_ATTR, (d) => this.bindFn(d, TYPES.AUTOMATION_POINT))
            .attr("r", AUTOMATION_HANDLE_RADIUS)
            .attr("x", (d) => xScale(d.point.time))
            .attr("y", (d) => {
              return yScale(d.track)! + (1 - d.point.value) * this.trackHeight;
            });
        },
        (update) => {
          return update
            .filter((d) => this.#filterFn(d))
            .attr("x", (d) => xScale(d.point.time))
            .attr("y", (d) => {
              return yScale(d.track)! + (1 - d.point.value) * this.trackHeight;
            });
        },
        (remove) => remove.remove()
      );
  }

  onRender(
    selection: Selection<any, any, any, any>,
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    toHidden: boolean,
    xScale: ScaleLinear<number, number>
  ): void {
    const that = this;
    selection
      .selectAll<any, AutomationData>(`custom.${TYPES.AUTOMATION.description}`)
      .each(function (d) {
        if (toHidden) return;

        const node = d3.select(this);

        const fillColor = "black";
        const yStart = +node.attr("y");

        const automation = that.#automationMap.get(d.automation)!;

        ctx.beginPath();
        // start at origin
        ctx.moveTo(0, yStart + that.trackHeight * automation.origin);

        // draw lines between automation points
        for (const point of d.data) {
          const x = xScale(point.time);
          const y = yStart + that.trackHeight * (1 - point.value);
          ctx.lineTo(x, y);
        }

        // end at value of last point
        ctx.lineTo(
          ctx.canvas.width,
          yStart + that.trackHeight * (1 - d.data[d.data.length - 1].value)
        );
        ctx.strokeStyle = fillColor;
        ctx.stroke();
      });

    selection
      .selectAll<any, AutomationBindData>(
        `custom.${TYPES.AUTOMATION_POINT.description}`
      )
      .each(function (d) {
        const node = d3.select(this);

        const uniqueColor = node.attr(BIND_ATTR);
        const fillColor = toHidden ? uniqueColor : node.attr("fill");

        const x = +node.attr("x");
        const y = +node.attr("y");
        const r = +node.attr("r");

        if (toHidden) {
          // draw rect to hidden
          ctx.fillStyle = uniqueColor;
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
        } else {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.fillStyle = fillColor;
          ctx.fill();
        }
      });
  }

  onDragAutomationPoint(
    e: d3.D3DragEvent<any, any, any>,
    d: BoundData<AutomationBindData>,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>
  ) {
    const automationData = this.#automationDataMap.get(d.data.automationData)!;
    const point = d.data.point;

    const time = xScale.invert(e.x);
    const trackYStart = yScale(automationData.track)!;
    const valueInTrack = e.y - trackYStart;
    const value = 1 - valueInTrack / this.trackHeight;

    const index = automationData.data.indexOf(point);
    const previousPoint = automationData.data[index - 1];
    const nextPoint = automationData.data[index + 1];
    const dataPoint = automationData.data[index];

    dataPoint.value = Math.min(1, Math.max(0, value));

    if (index === 0 && time < 0) {
      dataPoint.time = 0;
    } else if (previousPoint && time < previousPoint.time) {
      dataPoint.time = previousPoint.time;
    } else if (nextPoint && time > nextPoint.time) {
      dataPoint.time = nextPoint.time;
    } else {
      dataPoint.time = time;
    }
  }
}
