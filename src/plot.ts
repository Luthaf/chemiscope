import assert from "assert";

import * as Plotly from "./lib/plotly-scatter";
import {Config, Data, Layout, PlotlyHTMLElement} from "./lib/plotly-scatter";

import {COLOR_MAPS} from "./colorscales";
import {make_draggable} from "./draggable";

import {Property, Mode} from "./dataset"
import {PlotProperties, NumericProperty} from "./plot_data"

const HTML_SETTINGS = require("./static/settings.html");

const DEFAULT_LAYOUT = {
    hovermode: "closest",
    showlegend: true,
    legend: {
        y: 1,
        yanchor: "top",
        tracegroupgap: 5,
        itemclick: false,
        itemdoubleclick: false,
    },
    title: {
        text: "",
        y: 0.982,
        x: 0.08,
        font: {
            size: 25,
        },
    },
    xaxis: {
        title: "",
        zeroline: false,
    },
    yaxis: {
        title: "",
        zeroline: false,
    },
    margin: {
        l: 50,
        t: 50,
        r: 50,
        b: 50,
    }
};

const DEFAULT_CONFIG = {
    displayModeBar: true,
    displaylogo: false,
    scrollZoom: true,
    modeBarButtonsToRemove: [
        "hoverClosestCartesian",
        "hoverCompareCartesian",
        "toggleSpikelines",
        "autoScale2d",
        "zoomIn2d",
        "zoomOut2d",
        "select2d",
        "lasso2d",
        "hoverClosest3d",
        "tableRotation",
        "resetCameraLastSave3d",
    ],
};

function getByID<HTMLType>(id: string): HTMLType {
    const e = document.getElementById(id);
    if (e === null) {
        throw Error(`unable to get element with id ${id}`);
    }
    return e as unknown as HTMLType;
}

export class ScatterPlot {
    /// HTML root holding the full plot
    private _root: HTMLElement;
    /// Plotly plot
    private _plot!: PlotlyHTMLElement;
    /// The dataset name
    private _name: string;
    /// All known properties
    private _allProperties: PlotProperties;
    /// Storing the callback for when the plot is clicked
    private _selectedCallback: (index: number) => void;
    /// Index of the currently selected point
    private _selected: number;
    /// Are we showing a 2D or 3D plot
    private _is3D: boolean;
    /// Current mode: displaying structure or atomic properties
    private _mode: Mode;
    /// Currently displayed data
    private _current!: {
        /// Name of the properties in `this._properties()` used for x values
        x: string,
        /// Name of the properties in `this._properties()` used for y values
        y: string,
        /// Name of the properties in `this._properties()` used for z values,
        /// `undefined` for 2D plots
        z?: string,
        /// Name of the colorscale to use
        colorscale: string,
        /// Name of the properties in `this._properties()` used for color
        /// values, `undefined` when using the default colors
        color?: string,
        /// Name of the properties in `this._properties()` used for size values,
        /// `undefined` when using the default sizes
        size?: string,
        /// Name of the properties in `this._properties()` used for symbols
        /// values, `undefined` when using the default symbols
        symbols?: string,
    }
    /// callback to get the initial positioning of the settings modal. The
    /// callback gets the current placement of the settings as a DOMRect, and
    /// should return top and left positions in pixels, used with
    /// `position: fixed`
    private _settingsPlacement!: (rect: DOMRect) => {top: number, left: number};

    constructor(id: string, name: string, mode: Mode, properties: {[name: string]: Property}) {
        this._name = name;
        this._mode = mode;
        this._selectedCallback = (_) => { return; };
        this._selected = 0;
        this._is3D = false;

        const root = document.getElementById(id);
        if (root === null) {
            throw Error(`could not find HTML element #${id}`)
        }
        this._root = root;
        this._root.style.position = 'relative';

        this._plot = document.createElement("div") as unknown as PlotlyHTMLElement;
        this._plot.style.width = "100%";
        this._plot.style.height = "100%";
        this._plot.style.minHeight = "550px";
        this._root.appendChild(this._plot);

        this._allProperties = new PlotProperties(properties);
        this._setupDefaults();

        this._createSettings();
        this._setupSettings();

        this._createPlot();
    }

    /// Register a callback to be called when the selected environment is
    /// updated
    public onSelectedUpdate(callback: (index: number) => void) {
        this._selectedCallback = callback;
    }

    /// Change the selected environment to the one with the given `index`
    public select(index: number) {
        if (index === this._selected) {
            // HACK: Calling Plotly.restyle fires the plotly_click event
            // again for 3d plots, ignore it
            return;
        }
        this._selected = index;

        Plotly.restyle(this._plot, {
            x: this._xValues(1),
            y: this._yValues(1),
            z: this._zValues(1),
            "marker.symbol": this._symbols(1),
        } as Data, 1);
        this._selectedCallback(this._selected);
    }

    /// Change the current dataset to the provided one, without re-creating the
    /// plot
    public changeDataset(name: string, mode: Mode, properties: {[name: string]: Property}) {
        this._name = name;
        this._mode = mode;
        this._selected = 0;
        this._allProperties = new PlotProperties(properties);
        this._current.z = undefined;
        this._setupDefaults();
        this._setupSettings();
        this._createPlot();
    }

    /// Use the given callback to compute the placement of the settings modal.
    ///
    /// The callback gets the current placement of the settings as a DOMRect,
    /// and should return top and left positions in pixels, used with `position:
    /// fixed`. The callback is called once, the first time the settings are
    /// opened.
    public computeSettingsPlacement(callback: (rect: DOMRect) => {top: number, left: number}) {
        this._settingsPlacement = callback;
    }

    private _setupDefaults() {
        const prop_names = Object.keys(this._properties());
        if (prop_names.length < 2) {
            throw Error("Sketchmap needs at least two properties to plot")
        }
        this._current = {
            x: prop_names[0],
            y: prop_names[1],
            colorscale: 'inferno',
        }
        if (prop_names.length > 2) {
            this._current.color = prop_names[2];
            this._current.z = prop_names[2];
        } else {
            this._current.z = prop_names[0];
        }
    }

    private _createSettings() {
        // use HTML5 template to generate a DOM object from an HTML string
        const template = document.createElement('template');
        template.innerHTML = `<button
            href="#skv-settings"
            class="btn btn-light btn-sm skv-open-settings"
            data-toggle="modal">
                <div class="skv-hamburger"><div></div><div></div><div></div></div>
            </button>`;
        const openSettings = template.content.firstChild!;
        this._root.append(openSettings);

        // replace id to ensure they are unique even if we have mulitple viewers
        // on a single page
        template.innerHTML = HTML_SETTINGS;
        const modal = template.content.firstChild!;
        document.body.appendChild(modal);

        const modalDialog = modal.childNodes[1]! as HTMLElement
        if (!modalDialog.classList.contains('modal-dialog')) {
            throw Error("internal error: missing modal-dialog class")
        }
        // make the settings modal draggable
        make_draggable(modalDialog, ".modal-header");

        // Position modal near the actual viewer
        openSettings.addEventListener('click', () => {
            // only set style once, on first open, and keep previous position
            // on next open to keep the 'draged-to' position
            if (modalDialog.getAttribute('data-initial-modal-positions-set') === null) {
                modalDialog.setAttribute('data-initial-modal-positions-set', "true");

                // display: block to ensure modalDialog.offsetWidth is non-zero
                (modalDialog.parentNode as HTMLElement).style.display = 'block';

                const {top, left} = this._settingsPlacement(modalDialog.getBoundingClientRect());

                // set width first, since setting position can influence it
                modalDialog.style.width = `${modalDialog.offsetWidth}px`;
                // unset margins when using position: fixed
                modalDialog.style.margin = '0';
                modalDialog.style.position = 'fixed';
                modalDialog.style.top = `${top}px`;
                modalDialog.style.left = `${left}px`;
            }
        })

        // By default, position the modal for settings on top of the plot,
        // centered horizontally
        this._settingsPlacement = (rect: DOMRect) => {
            const rootRect = this._root.getBoundingClientRect();
            return {
                top: rootRect.top + 20,
                left: rootRect.left + rootRect.width / 2 - rect.width / 2,
            }
        }
    }

    private _setupSettings() {
        // ============== Setup the map options ==============
        // ======= data used as x values
        const selectX = getByID<HTMLSelectElement>('skv-x');
        selectX.options.length = 0;
        for (const key in this._properties()) {
            selectX.options.add(new Option(key, key));
        }
        selectX.selectedIndex = 0;

        selectX.onchange = () => {
            this._current.x = selectX.value;
            Plotly.restyle(this._plot, { x: this._xValues() }, [0, 1])
                .catch(e => console.error(e));
            Plotly.relayout(this._plot, {
                'xaxis.title': this._current.x,
                'scene.xaxis.title': this._current.x,
            } as unknown as Layout).catch(e => console.error(e));
        }

        // ======= data used as y values
        const selectY = getByID<HTMLSelectElement>('skv-y');
        selectY.options.length = 0;
        for (const key in this._properties()) {
            selectY.options.add(new Option(key, key));
        }
        selectY.selectedIndex = 1;

        selectY.onchange = () => {
            this._current.y = selectY.value;
            Plotly.restyle(this._plot, { y: this._yValues() }, [0, 1])
                .catch(e => console.error(e));
            Plotly.relayout(this._plot, {
                'yaxis.title': this._current.y,
                'scene.yaxis.title': this._current.y,
            } as unknown as Layout).catch(e => console.error(e));
        }

        // ======= data used as z values
        const selectZ = getByID<HTMLSelectElement>('skv-z');
        selectZ.options.length = 0;
        for (const key in this._properties()) {
            selectZ.options.add(new Option(key, key));
        }
        selectZ.selectedIndex = selectZ.options.length >= 2 ? 2 : 0;

        selectZ.onchange = () => {
            this._current.z = selectZ.value;
            Plotly.restyle(this._plot, { z: this._zValues() } as Data, [0, 1])
                .catch(e => console.error(e));
            Plotly.relayout(this._plot, {
                'scene.zaxis.title': this._current.z,
            } as unknown as Layout).catch(e => console.error(e));
        }

        // ======= marker color
        const selectColor = getByID<HTMLSelectElement>('skv-color');
        selectColor.options.length = 1;
        for (const key in this._properties()) {
            selectColor.options.add(new Option(key, key));
        }
        if (this._hasColors()) {
            // index 0 is 'none', 1 is the x values, 2 the y values, use 3 for
            // colors
            selectColor.selectedIndex = 3;
        }

        selectColor.onchange = () => {
            if (selectColor.value !== "") {
                this._current.color = selectColor.value;
            } else {
                this._current.color = undefined;
            }

            const data = {
                hovertemplate: this._hovertemplate(),
                'marker.color': this._colors(0),
                'marker.line.color': this._lineColors(0),
                'marker.colorbar.title': this._current.color,
            };

            Plotly.restyle(this._plot, data as Data, 0)
                .catch(e => console.error(e));
        }

        // ======= color palette
        const selectPalette = getByID<HTMLSelectElement>('skv-palette');
        selectPalette.options.length = 0;
        for (const key in COLOR_MAPS) {
            selectPalette.options.add(new Option(key, key));
        }
        selectPalette.value = this._current.colorscale;

        selectPalette.onchange = () => {
            this._current.colorscale = selectPalette.value;
            const data = {
                'marker.colorscale': this._colorScale(0),
                'marker.line.colorscale': this._lineColorScale(0),
            };
            Plotly.restyle(this._plot, data as Data, 0)
                .catch(e => console.error(e));
        }

        // ======= marker symbols
        const selectSymbol = getByID<HTMLSelectElement>('skv-symbol');
        selectSymbol.options.length = 1;
        for (const key in this._properties()) {
            if (this._properties()[key].string !== undefined) {
                selectSymbol.options.add(new Option(key, key));
            }
        }

        selectSymbol.onchange = () => {
            if (selectSymbol.value !== "") {
                this._current.symbols = selectSymbol.value;
            } else {
                this._current.symbols = undefined;
            }

            Plotly.restyle(this._plot, {
                'marker.symbol': this._symbols(),
                'marker.colorbar.len': this._colorbarLen(),
            } as Data, [0, 1]).catch(e => console.error(e));

            Plotly.restyle(this._plot, {
                showlegend: this._showlegend(),
                name: this._legendNames(),
            } as unknown as Data).catch(e => console.error(e));
        }

        // ======= marker size
        const selectSize = getByID<HTMLSelectElement>('skv-size');
        selectSize.options.length = 1;
        for (const key in this._properties()) {
            selectSize.options.add(new Option(key, key));
        }
        selectSize.selectedIndex = 0;

        const sizeFactor = getByID<HTMLInputElement>('skv-size-factor');
        sizeFactor.value = "75";

        selectSize.onchange = () => {
            if (selectSize.value != "") {
                this._current.size = selectSize.value;
            } else {
                this._current.size = undefined;
            }

            const factor = parseInt(sizeFactor.value);
            Plotly.restyle(this._plot, { 'marker.size': this._sizes(factor, 0) } as Data, 0)
                .catch(e => console.error(e));
        };

        sizeFactor.onchange = () => {
            const factor = parseInt(sizeFactor.value);
            Plotly.restyle(this._plot, { 'marker.size': this._sizes(factor, 0) } as Data, 0)
                .catch(e => console.error(e));
        }

        // ======= select between 2D and 3D plots
        const plot2D = getByID<HTMLInputElement>('skv-2d-plot');
        plot2D.onchange = () => {
            selectSymbol.disabled = false;
            if (selectSymbol.value !== "") {
                this._current.symbols = selectSymbol.value;
            }

            selectZ.disabled = true;
            this._is3D = false;
            const factor = parseInt(sizeFactor.value);

            Plotly.restyle(this._plot, {
                type: 'scattergl',
                showlegend: this._showlegend(),
                name: this._legendNames(),
            } as unknown as Data).catch(e => console.error(e));

            const data = {
                z: this._zValues(),
                // size and symbols change from 2D to 3D
                'marker.size': this._sizes(factor),
                'marker.symbol': this._symbols(),
                // Use RGBA colorscale for opacity in 2D mode
                'marker.colorscale': this._colorScale(),
                'marker.line.size': [1, 1],
                'marker.colorbar.len': this._colorbarLen(),
            }
            Plotly.restyle(this._plot, data as Data, [0, 1]).catch(e => console.error(e));
        };

        const plot3D = getByID<HTMLInputElement>('skv-3d-plot');
        plot3D.onchange = () => {
            // Can not use symbols with 3D plots, why?
            selectSymbol.disabled = true;
            this._current.symbols = undefined;

            selectZ.disabled = false;
            this._is3D = true;
            const factor = parseInt(sizeFactor.value);

            Plotly.restyle(this._plot, {
                type: 'scatter3d',
                showlegend: this._showlegend(),
                name: this._legendNames(),
            } as unknown as Data).catch(e => console.error(e));

            const data = {
                z: this._zValues(),
                // size and symbols change from 2D to 3D
                'marker.size': this._sizes(factor),
                'marker.symbol': this._symbols(),
                // Do not use opacity in 3D mode, since it renders horribly
                'marker.colorscale': this._colorScale(),
                'marker.line.size': [0, 1],
                'marker.colorbar.len': this._colorbarLen(),
            }

            Plotly.restyle(this._plot, data as Data, [0, 1]).catch(e => console.error(e));
        };
    }

    private _createPlot() {
        this._plot.innerHTML = '';

        const colors = this._colors();
        const colorScales = this._colorScale();
        const lineColors = this._lineColors();
        const lineColorScale = this._lineColorScale();
        // default value for the size factor is 75
        const sizes = this._sizes(75);
        const symbols = this._symbols();

        const x = this._xValues();
        const y = this._yValues();
        const z = this._zValues();

        // The main trace, containing default data
        const main = {
            type: "scattergl",
            name: this._name,
            x: x[0],
            y: y[0],
            z: z[0],
            hovertemplate: this._hovertemplate(),
            showlegend: false,
            mode: "markers",
            marker: {
                color: colors[0],
                colorscale: colorScales[0],
                size: sizes[0],
                symbol: symbols[0],
                line: {
                    color: lineColors[0],
                    colorscale: lineColorScale[0],
                    width: 1,
                },
                showscale: true,
                // prevent plolty from messing with opacity when doing bubble
                // style charts (different sizes for each point)
                opacity: 1,
                colorbar: {
                    title: this._current.color,
                    thickness: 20,
                    len: 1,
                    y: 0,
                    yanchor: "bottom",
                },
            },
        };

        // Create a second trace to store the last clicked point, in order to
        // display it on top of the main plot with different styling
        const selected = {
            type: "scattergl",
            name: "",
            x: x[1],
            y: y[1],
            z: z[1],
            hoverinfo: "none",
            showlegend: false,
            mode: "markers",
            marker: {
                color: colors[1],
                colorscale: colorScales[1],
                size: sizes[1],
                symbol: symbols[1],
                line: {
                    color: lineColors[1],
                    colorscale: lineColorScale[1],
                    width: 0.5,
                },
            },
        };
        const traces = [main as Data, selected as Data];

        // add empty traces to be able to display the symbols legend
        // one trace for each possible symbol
        for (let i=0; i<this._allProperties.maxSymbols; i++) {
            const data = {
                type: "scattergl",
                name: "",
                x: [NaN],
                y: [NaN],
                z: [NaN],
                hoverinfo: "none",
                showlegend: false,
                legendgroup: i.toString(),
                mode: "markers",
                marker: {
                    color: "black",
                    size: sizes[0],
                    symbol: i,
                },
            };
            traces.push(data as Data);
        }

        const layout = {
            ...DEFAULT_LAYOUT,
            'title.text': this._name,
            'xaxis.title': this._current.x,
            'yaxis.title': this._current.y,
            'scene.xaxis.title': this._current.x,
            'scene.yaxis.title': this._current.y,
            'scene.zaxis.title': this._current.z,
        };

        // Create an empty plot and fill it below
        Plotly.newPlot(this._plot,
            traces,
            layout as Partial<Layout>,
            DEFAULT_CONFIG as Config
        ).catch(e => console.error(e));

        this._plot.on("plotly_click", (event: Plotly.PlotMouseEvent) => this.select(event.points[0].pointNumber));
    }

    private _properties(): {[name: string]: NumericProperty} {
        return this._allProperties[this._mode]
    }

    /// Get the plotly hovertemplate depending on `this._current.color`
    private _hovertemplate(): string {
        if (this._hasColors()) {
            return this._current.color + ": %{marker.color:.2f}<extra></extra>";
        } else {
            return "%{x:.2f}, %{y:.2f}<extra></extra>";
        }
    }

    /// Get the values to use for the x axis with the given plotly `trace`
    private _xValues(trace?: number): Array<number[]> {
        const values = this._properties()[this._current.x].values;
        return this._selectTrace(values, [values[this._selected]], trace);
    }

    /// Get the values to use for the y axis with the given plotly `trace`
    private _yValues(trace?: number): Array<number[]> {
        const values = this._properties()[this._current.y].values;
        return this._selectTrace(values, [values[this._selected]], trace);
    }

    /// Get the values to use for the z axis with the given plotly `trace`
    private _zValues(trace?: number): Array<undefined | number[]> {
        if (!this._is3D) {
            return this._selectTrace(undefined, undefined, trace);
        }

        const values = this._properties()[this._current.z!].values;
        return this._selectTrace(values, [values[this._selected]], trace);
    }

    /// Get the color values to use with the given plotly `trace`
    private _colors(trace?: number): Array<string | number | number[]> {
        let values;
        if (this._hasColors()) {
            values = this._properties()[this._current.color!].values;
        } else {
            values = 0.5;
        }

        return this._selectTrace<string | number | number[]>(values, "#007bff", trace);
    }

    /// Get the line color values to use with the given plotly `trace`
    private _lineColors(trace?: number): Array<string | number | number[]> {
        let values;
        if (this._hasColors()) {
            values = this._properties()[this._current.color!].values;
        } else {
            values = 0.5;
        }

        return this._selectTrace<string | number | number[]>(values, "black", trace);
    }

    /// Get the colorscale to use for markers in the main plotly trace
    private _colorScale(trace?: number): Array<undefined | Plotly.ColorScale> {
        let colormap = COLOR_MAPS[this._current.colorscale];
        if (this._is3D) {
            return this._selectTrace(colormap.rgb, undefined, trace);
        } else {
            return this._selectTrace(colormap.rgba, undefined, trace);
        }
    }

    /// Get the colorscale to use for markers lines in the main plotly trace
    private _lineColorScale(trace?: number): Array<undefined | Plotly.ColorScale> {
        const colormap = COLOR_MAPS[this._current.colorscale].rgb;
        return this._selectTrace(colormap, undefined, trace);
    }

    /// Get the size values to use with the given plotly `trace`
    private _sizes(sizeSliderValue: number, trace?: number): Array<number | number[]> {
        // Transform the linear value from the slider into a logarithmic scale
        const logSlider = (value: number) => {
            const min_slider = 1;
            const max_slider = 100;

            const min_value = Math.log(1.0 / 6.0);
            const max_value = Math.log(2.0);

            const factor = (max_value - min_value) / (max_slider - min_slider);
            return Math.exp(min_value + factor * (value - min_slider));
        }

        const factor = logSlider(sizeSliderValue);
        const defaultSize = this._is3D ? 4.5 : 10;
        let values;
        if (this._current.size === undefined) {
            values = defaultSize * factor;
        } else {
            const sizes = this._properties()[this._current.size].values;
            const min = Math.min.apply(Math, sizes);
            const max = Math.max.apply(Math, sizes);
            const defaultSize = this._is3D ? 12 : 20;
            // normalize inside [0, 10 * factor]
            values = sizes.map((v) => {
                const scaled = (v - min) / (max - min);
                return defaultSize * factor * (scaled + 0.05);
            })
        }

        return this._selectTrace(values, 2 * defaultSize, trace);
    }

    /// Get the symbol values to use with the given plotly `trace`
    private _symbols(trace?: number): Array<number | number[]> {
        if (this._current.symbols !== undefined) {
            assert(!this._is3D);
            const values = this._properties()[this._current.symbols].values;
            return this._selectTrace<number | number[]>(values, values[this._selected], trace);
        } else {
            // default to 0 (i.e. circles)
            return this._selectTrace<number | number[]>(0, 0, trace);
        }
    }

    private _showlegend(): Array<boolean> {
        const result = [false, false];

        if (this._current.symbols !== undefined) {
            assert(!this._is3D);
            for (let i=0; i<this._symbolsCount()!; i++) {
                result.push(true);
            }
            return result;
        } else {
            for (let i=0; i<this._allProperties.maxSymbols; i++) {
                result.push(false);
            }
            return result;
        }
    }

    private _legendNames(): Array<string> {
        const result = [this._name, ""];

        if (this._current.symbols !== undefined) {
            assert(!this._is3D);
            const names = this._properties()[this._current.symbols].string!.strings();
            for (const name of names) {
                result.push(name);
            }
            return result;
        } else {
            for (let i=0; i<this._allProperties.maxSymbols; i++) {
                result.push("");
            }
            return result;
        }
    }

    private _selectTrace<T>(main: T, selected: T, trace?: number): Array<T> {
        if (trace === 0) {
            return [main];
        } else if (trace === 1) {
            return [selected]
        } else if (trace === undefined) {
            return [main, selected]
        } else {
            throw Error("internal error: invalid trace number")
        }
    }

    /// How many different symbols are being displayed
    private _symbolsCount(): number {
        if (this._current.symbols !== undefined) {
            return this._properties()[this._current.symbols].string!.strings().length;
        } else {
            return 0;
        }
    }

    private _colorbarLen(): Array<number | undefined> {
        /// Heigh of a legend item in plot unit
        const LEGEND_ITEM_HEIGH = 0.045;
        return [1 - LEGEND_ITEM_HEIGH * this._symbolsCount(), undefined]
    }

    private _hasColors(): boolean {
        return this._current.color !== undefined;
    }
}
