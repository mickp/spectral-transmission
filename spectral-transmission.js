/* -*- coding: utf-8
 * Spectral Transmission tool
 *
 * Copyright 2017 Mick Phillips (mick.phillips@gmail.com)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

// Extensions to strip from source filenames, and files to exclude.
var FN_EXCLUDE = [".csv", ".Csv", "CSV", "index.html"];
// regex strings
// match a floating point number
FLOATMATCH = /([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)/;
// match a quantum yield entry
QYIELDMATCH = /[Qq]uantum [Yy]ield:\s*([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)/;
// match an exctinction coefficient entry
EXTCOEFFMATCH = /[Ee]xtinction [Cc]oefficient:\s*([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)/;
// Alexa-488 birghtness for relative brightness calculations
var ALEXABRIGHT= 0.92*73000;
// The set of active filters.
var CHART = null;
var SPECTRA = {};
// Interpolation parameters.
var WLMIN = 300.0;
var WLMAX = 800.0;
var WLSTEP = 1.0;
// Suffix for excitation spectra
var EXSUFFIX = "_ex";
// How many top dyes to return
var NUMTOPDYES = 3;

/* Required page elements:
 * #sets    - a list of predefined filter sets
 * #fset    - the active filter set
 * #filters - a list of available filters
 * #dyes    - a list of available dyes
 * #exset   - excitation filter set
 */

// Dash styles generator.
DASHES = function* () {
    var styles = [[8,4], [16,4], [4,8,4], [4,8,8]];
    var index = -1;
    while(true){
        index = (index+1) % styles.length;
        yield styles[index];
    }
}();

//extract url queiers.
function getParameterByName(name, url) {
    if (!url) url = window.location.href;
    name = name.replace(/[\[\]]/g, "\\$&");
    var regex = new RegExp("[?&]" + name + "(=([^&#]*)|&|#|$)"),
        results = regex.exec(url);
    if (!results) return null;
    if (!results[2]) return "";
    return decodeURIComponent(results[2].replace(/\+/g, " "));
}

// ==== Spectrum base === //
function Spectrum(name) {
    this.name = name;       // name
    this.raw=null;          // raw data after fetch
    this._interp=null;      // cache for interpolated data
    this._points=null;      // cache for points as [{x: , y:}, ...]
    this.qyield=null;       // quantum yield
    this.extcoeff=null;     // extinction coefficent
}


Spectrum.prototype.interpolate = function () {
    // Resample raw data. Assumes input data is sorted by wavelength.
    if (!this._interp ||
        this._interp[0][0] !== WLMIN ||
        this._interp[0][this._interp[0].length-1] !== WLMAX ||
        this._interp[0].length !== 1+(WLMAX-WLMIN) / WLSTEP) {
        // Need to interpolate.
        // Invalidates previously-interpolated points.
        this._points = null;
        this._interp = [[],[]];
        var wls;
        var vals;
        [wls, vals] = this.raw || [[0,1], [0,0]];
        var i = 1; // Index into original data.
        for (wl = WLMIN; wl <= WLMAX; wl += WLSTEP) {
            var val;
            var t;
            if (wl < wls[0] || wl > wls[wls.length-1]){
                val = 0;
            } else {
                if (wl > wls[i]) {
                    while(wl > wls[i]) {
                        i += 1;
                    }
                }
                t = (wl - wls[i-1]) / (wls[i] - wls[i-1]);
                val = (1-t)*vals[i-1]+t*vals[i];
            }
            this._interp[0].push(wl);
            this._interp[1].push(val);
        }
    }
    return this._interp;
};

Spectrum.prototype.rescale = function() {
    // Find max. intensity in spectrum.
    if (this.raw[1].reduce( (peak, val) => val > peak ? val : peak) > 10.0) {
        // Spectrum is probably in percent
        for (var i = 0; i < this.raw[1].length; i++) {
            this.raw[1][i] = this.raw[1][i] / 100;
        }
    }
};

Spectrum.prototype.area = function (name) {
    // Return the area of the spectrum.
    // Clamps negative values to zero.
    var w;
    var v;
    [w,v] = this.interpolate();
    var area = 0;
    for (var i=1; i < w.length; i++) {
        area += 0.5 * (Math.max(0, v[i]) + Math.max(0, v[i-1]))*(w[i] - w[i-1]);
    }
    return area;
};

Spectrum.prototype.copy = function (name) {
    // Create a copy of this spectrum.
    copy = new Spectrum(name);
    copy.raw = null;
    copy._interp = deepCopy(this.interpolate());

    return copy;
};

Spectrum.prototype.multiplyBy = function (other) {
    // multiplies this spectrum by other
    // invalidates previously calculated _points
    this._points = null;
    this.interpolate();
    var oldMax = Math.max(...this._interp[1]);
    if (other instanceof Spectrum) {
        var m = other.interpolate()[1];
        for (var i = 0; i < this._interp[1].length; i ++) {
            this._interp[1][i] *= m[i];
        }
    } else if (Array.isArray(other)) {
        for (var i = 0; i < this._interp[1].length; i ++) {
            this._interp[1][i] *= other[i];
        }
    } else {
        for (var i = 0; i < this._interp[1].length; i ++) {
            this._interp[1][i] *= other;
        }
    }
};


Spectrum.prototype.peakwl = function () {
    // Return the wavelength of the peak.
    if (this._interp) {
        var peakidx = this._interp[1].indexOf(Math.max(...this._interp[1]));
        return this._interp[0][peakidx];
    }
};


Spectrum.prototype.points = function () {
    // Return points as {x: xval, y: yval}
    if (this._points) {
        return this._points;
    } else {
        var data = this.interpolate();
        return data[0].map(function (v, i) {
            return {x: v, y:data[1][i]};
        });
    }
};


//Prototype sets object for staroing exciation and emission sets.
function FilterSet(){
    //transmission is the total transmission efficiency of the
    //set of filters
    //spectrum is the resulting spectrum after the filter stack is applied
    this.transmission = null;
    this.spectrum = null;
}

FilterSet.prototype = new Array();

FilterSet.prototype.addFilter = function(filter, mode) {
    //filter is the filter name,
    //mode is "r" or "t" for reflection or transmission
    this.push({"filter":filter, "mode":mode});
};

FilterSet.prototype.removeFilter = function(filter){
    var filternum = this.findIndex(function(element){
        if (element) {
            return (element.filter === filter);
        }
    });

    if (filternum > -1){
        delete this[filternum];
    }
};

FilterSet.prototype.changeMode = function(filter,mode){
    var filternum = this.findIndex(function(element){
        if (element) {
            return (element.filter === filter);
        }
    });

    if (filternum > -1){
        this[filternum].mode = mode;
    }
};


FilterSet.prototype.doEfficiencyCalc = function () {
    var initArea = SPECTRA[this[0].filter].area();
    var calcSpectra  =SPECTRA[this[0].filter].copy();
    this.slice(1).forEach(function(element){
        var refl = ["r","R"].indexOf(element.mode) > -1;
        if (refl) {
            var mult = SPECTRA[element.filter].interpolate()[1].map((v) => {return Math.max(0, 1-v);});
            calcSpectra.multiplyBy(mult);
        } else {
            calcSpectra.multiplyBy(SPECTRA[element.filter]);
        }
    });
    this.transmission=calcSpectra.area()/initArea;
    this.spectrum=calcSpectra;
};


FilterSet.prototype.efficiency = function( ){

    // Fetch all data with concurrent calls.
    var defer = [];
    for (var f of this) {
        //RemoveFilter leaves an undfined entry so skip these
        if(f) {
            if(f.filter) {
                defer.push(SPECTRA[f.filter].fetch());
            }
        }
    }
    // When all the data is ready, do the calculation.
    $.when.apply(null, defer).then( () => this.doEfficiencyCalc() );
};

// calculate the excitation, emission and brightness of a config.
function calcEffAndBright(exset,emset) {
    //populate the tramsssion and spectrum elements of the filter set
    //in emset first element must be a dye
    //in exset first element must be a light source
    var e_eff,t_eff,bright;
    //Excitation efficiency
    if (exset.length > 0) {
        exset.efficiency();
        e_eff = exset.transmission;
        SPECTRA["excitation"] = exset.spectrum.copy();
        //test if we have a dye selected, and it has an excitation spectra
        //if so multiply excitation spectra by this.
        if(emset[0].filter && SPECTRA[emset[0].filter + EXSUFFIX]) {
            exset.spectrum.multiplyBy(SPECTRA[emset[0].filter + EXSUFFIX]);
            e_eff = e_eff * (exset.spectrum.area()/SPECTRA["excitation"].area());
        }
    }
    //calculate emission efficiency and spectra.
    if (emset.length > 0) {
        emset.efficiency();
        t_eff = emset.transmission;
        SPECTRA["transmitted"]=emset.spectrum;
    }
    //calculate relative brightness compared to alexa-448 at 100% excitation.
    // mulitple by 10 to give resasonable range of values.
    var dye = emset[0].filter;
    if (dye && e_eff && SPECTRA[dye].qyield && SPECTRA[dye].extcoeff && t_eff) {
        bright = ((e_eff*SPECTRA[dye].qyield * SPECTRA[dye].extcoeff * t_eff)/
                   ALEXABRIGHT) * 10.0;
    }
    return ({e_eff,t_eff,bright});
}


//Function to try all possible dyes and optimise which is "best"
function optimiseDyes() {
    //First load all the dyes prior to calling the dye optimisation code.
    var dyes=[];
    $( "#dyes .selectable").each(function() {dyes.push($(this).data().key);});

    // Fetch all dyes with concurrent calls.
    var defer = [];
    for (var dye of dyes) {
        defer.push(SPECTRA[dye].fetch());
    }
    // When all the data is ready call the optimise dyes
    $.when.apply(null, defer).then(function(){processAllDyes(dyes);});
}


// === ServerSpectrum - spectrum with data from server === //
function ServerSpectrum(source, name) {
    Spectrum.call(this, name);
    this.source = source;   // source url
}

ServerSpectrum.prototype = new Spectrum();

ServerSpectrum.prototype.fetch = function ( ){
    // Fetch data for item if not already available.
    // Used deferred item to allow concurrent fetches.
    var d = $.Deferred();
    if (this.raw === null) {
    $.get(this.source,
        $.proxy(function(resp){
            // Parse csv.
            var csv = resp.split("\n");
            var wls = []; // wavelength
            var val0s = []; // value0
            var val1s = []; // aux. value
            for (let [index, line] of csv.entries()) {
                let strings = line.split(FLOATMATCH);
                let sepstrings = strings.filter((el, i, arr) => i%2 === 0);
                // Skip header lines.
                if(!sepstrings.every( v => v === "" || (/^[\s,;:]+$/).test(v))){
                    // Match Qyield and Extcoeff values.
                    // this data gets added to the emission spectra as
                    // we dont know yet if this is 2 column or 3 column data.
                    let strings = line.match(QYIELDMATCH);
                    if (strings){
                        this.qyield=strings[1];
                        continue;
                    }
                    strings = line.match(EXTCOEFFMATCH);
                    if (strings){
                        this.extcoeff=strings[1];
                    }
                    continue;
                }
                let floatstrings = strings.filter((el, i, arr) => i%2 === 1);
                let [wl, val0, val1] = floatstrings.map( v => parseFloat(v));
                if (wl != null && val0 != null) {
                    wls.push(wl);
                    val0s.push(val0);
                    if (val1 != null) {
                        val1s.push(val1);
                    }
                }
            }

            if (val1s.length === val0s.length) {
                // 3 columns of data: wl, excitation, emission
                // Create a new spectrum for the excitation.
                this.raw = [wls, val1s];
                this.rescale();
                let n = this.name + EXSUFFIX;
                SPECTRA[n] = new Spectrum(n);
                SPECTRA[n].raw = [wls, val0s];
                SPECTRA[n].rescale();
            } else {
                // 2 columns of data: wl, emission
                this.raw = [wls, val0s];
                this.rescale();
            }
            d.resolve();
        }, this),
        "text");
    } else {
        d.resolve();
    }
    return d;
};

// === End of prototype definitions === //


function wavelengthToHue(wl) {
    // Convert a wavelength to HSL-alpha string.
    return Math.max(0.0, Math.min(300, 650-wl)) * 0.96;
}


function updatePlot() {
    // Prepare to redraw the plot.
    var dye = [];
    var excitation = [];
    var filters = [];
    var filterModes = [];
    var exFilters = [];
    var exFilterModes = [];

    // Fetch configuration from UI.
    $( "#dyes .selected").each(function() {dye.push($(this).data().key);});
    $( "#excitation .selected").each(function() {excitation.push($(this).data().key);});
    $( "#fset .activeFilter").each(function() {filters.push($(this).data().key);});
    $( "#fset .activeFilter").each(function() {filterModes.push($(this).data().mode);});
    //exciation filter sets.
    $( "#exset .activeExFilter").each(function() {exFilters.push($(this).data().key);});
    $( "#exset .activeExFilter").each(function() {exFilterModes.push($(this).data().mode);});

    // Fetch all data with concurrent calls.
    var defer = [];
    if (dye.length > 0){
        defer.push(SPECTRA[dye[0]].fetch());
    }
    if (excitation.length > 0) {
        defer.push(SPECTRA[excitation[0]].fetch());
    }
    for (var f of filters) {
        defer.push(SPECTRA[f].fetch());
    }
    for (var f of exFilters) {
        defer.push(SPECTRA[f].fetch());
    }

    // When all the data is ready, do the calculation and draw the plot.

    $.when.apply(null, defer).then(function(){drawPlot(dye[0], excitation[0], filters, filterModes,exFilters,exFilterModes);});
}


function deepCopy( src ) {
    // Deep copy an array of arrays.
    var i, target;
    if ( Array.isArray( src ) ) {
        target = src.slice(0);
        for( i = 0; i < target.length; i+=1 ) {
            target[i] = deepCopy( target[i] );
        }
        return target;
    } else {
        return src;
    }
}

function drawPlot(dye, excitation, filters, filterModes, exFilters, exFilterModes) {
    // Create chart if it doesn't exist.
    if (!CHART) {
        var ctx = $( "#chart" )[0].getContext("2d");
        CHART = new Chart(ctx, {
            type: "scatter",
            height: `100%`,
            data: {
                datasets: [{
                    label: "transmitted",
                    data: [],
                    borderWidth: 4,
                    borderColor: `rgba(0, 0, 0, 0.5)`,
                    pointRadius: 0,
                }]
            },
            options:{
                responsive: true,
                maintainAspectRatio: false,
            }
        });
        CHART.options.scales.xAxes[0].scaleLabel.display = true;
        CHART.options.scales.xAxes[0].scaleLabel.labelString = "wavelength / nm";
        // Set chart height now, and on window resize.
        var resizeChart = () => {
            var frac = Math.floor(100*Math.min(
                (1- $( CHART.canvas ).position().top / $( window ).height()),
                $( CHART.canvas ).width() / $( window ).height()));
            CHART.canvas.parentNode.style.height = `${frac}vh`;
        };
        resizeChart();
        $(window).resize(resizeChart);
    }

    // Calculate excitation emission efficiency, brightness and spectra.
    var effBright = calcEffAndBright(EXSET,EMSET);
    var e_eff = effBright.e_eff ;
    var t_eff = effBright.t_eff ;
    var bright = effBright.bright ;

    var skeys = []; // all active keys (filters + dye)
    dye = $("#dyes .selected").data("key");
    if (dye) {
        skeys.push(dye);
        if (SPECTRA[dye + EXSUFFIX]) {
            skeys.push(dye + EXSUFFIX);
        }
    }
    if (excitation) {
        if (exFilters.length >= 1) {
            skeys.push("excitation");
        } else {
            skeys.push(excitation);
        }
    }

    skeys.push.apply(skeys, filters);

    var traces = CHART.data.datasets.map( item => item.label );
    var toRemove = traces.filter(item => skeys.indexOf(item) === -1);
    var toAdd = skeys.filter(item => traces.indexOf(item) === -1 );

    // Remove traces that are no longer needed.
    for (var key of toRemove) {
        if (key == "transmitted") { continue; }
        CHART.data.datasets.splice(
            CHART.data.datasets.indexOf(
                CHART.data.datasets.filter(item => item.label == key)[0]), 1);
    }

    // Add new traces.
    for (var key of toAdd) {
        var bg;
        var fg;
        var borderDash;
        var data = SPECTRA[key].points();
        var hue = wavelengthToHue(SPECTRA[key].peakwl());
        switch (key) {
            case excitation:
                bg = `hsla(${hue}, 100%, 50%, 1)`;
                fg = `hsla(${hue}, 100%, 50%, 1)`;
                var addToChart = x => CHART.data.datasets.splice(1, 0, x);
                break;
            case "excitation":
                bg = `hsla(${hue}, 100%, 50%, 1)`;
                fg = `hsla(${hue}, 100%, 50%, 1)`;
                var addToChart = x => CHART.data.datasets.splice(1, 0, x);
                break;
            case dye:
                bg = `hsla(${hue}, 100%, 50%, 0.2)`;
                fg = `rgba(0, 0, 255, 0.5)`;
                var addToChart = x => CHART.data.datasets.splice(1, 0, x);
                break;
            case dye + EXSUFFIX:
                bg = `hsla(${hue}, 100%, 50%, 0.2)`;
                fg = `rgba(255, 0, 0, 0.5)`;
                var addToChart = x => CHART.data.datasets.splice(1, 0, x);
                break;
            default:
                bg = `hsla(${hue}, 100%, 50%, 0.1)`;
                fg = `hsla(${hue}, 100%, 50%, 0.5)`;
                borderDash = DASHES.next().value;
                var addToChart = x => CHART.data.datasets.push(x);
        }

        addToChart({
                label: key,
                data: data,
                backgroundColor: bg,
                pointRadius: 0,
                borderDash: borderDash,
                borderColor: fg,
        });
    }


    // Fill traces according to transmission/reflection
    for (var i=0; i < CHART.data.datasets.length; i++) {
        var idx = filters.indexOf(CHART.data.datasets[i].label);
        if (idx === -1) { continue; }
        if (["r","R"].indexOf(filterModes[idx]) > -1) {
            CHART.data.datasets[i].fill = "end";
        } else {
            CHART.data.datasets[i].fill = "start";
        }
    }

    // Update the transmission trace.
    var transTrace = CHART.data.datasets.filter( item => item.label == "transmitted")[0];
    var hue = wavelengthToHue(SPECTRA["transmitted"].peakwl());
    transTrace.data = SPECTRA["transmitted"].points();
    transTrace.backgroundColor = `hsla(${hue}, 100%, 50%, 0.8)`;
    // // Update the excitation trace.
    if (excitation) {
        if (exFilters.length >= 1) {
            var extTrace = CHART.data.datasets.filter( item => item.label == "excitation")[0];
            var hue = wavelengthToHue(SPECTRA["excitation"].peakwl());
            extTrace.data = SPECTRA["excitation"].points();
            extTrace.backgroundColor = `hsla(${hue}, 100%, 50%, 0.8)`;
            extTrace.foregroundColor = `hsla(${hue}, 100%, 50%, 0.8)`;
        } else {
            var extTrace = CHART.data.datasets.filter( item => item.label == excitation)[0];
            var hue = wavelengthToHue(SPECTRA[excitation].peakwl());
            extTrace.data = SPECTRA[excitation].points();
            extTrace.backgroundColor = `rgba(.5, .5, .5, 0.8)`;
        }
    }
    // if(excitation) {

    if (t_eff != null && e_eff != null && bright != null) {
       CHART.options.title = {display: true,
                               text: "Efficiency: ex " + (100*e_eff).toFixed(1) + "%, em " + (100*t_eff).toFixed(1) + "%" + ", brightness " + bright.toFixed(2),
                               fontSize: 24};
    } else if (t_eff != null && e_eff != null) {
        CHART.options.title = {display: true,
                               text: "Efficiency: ex " + (100*e_eff).toFixed(1) + "%, em " + (100*t_eff).toFixed(1) + "%",
                               fontSize: 24};
    } else if (t_eff != null) {
        CHART.options.title = {display: true,
                               text: "Efficiency:  " + (100*t_eff).toFixed(1) + "%",
                               fontSize: 24};
    } else {
        CHART.options.title = {display: false,
                               text: ""};
    }

    CHART.update();
}


function parseSources( sources )  {
    // Parse a \n-separated list of source files.
    var filters = {};
    for (var file of sources.split("\n")) {
        var name = file;
        for (var excl of FN_EXCLUDE) {
            name = name.split(excl).join("").trim();
        }
        if (name.length > 1) {
            filters[name] = file;
        }
    }
    return filters;
}

function parseSets( txt ) {
    // Parse pre-defined filter sets.
    var sets = [];

    for (var line of txt.split(/\n/)) {
        if (line.length <=1 || line.match(/^\s*(\/{2,2}|#|\/\*).*/)) {
            continue;
        }
        var emAndEx = line.split("::");
        if (emAndEx.length === 1) {
            var csv = line.split(/[\t,:;]/);
            var filters = csv.slice(3).map( (_) => _.trim().split(/ +/)).map(
                (_) => {return{filter:_[0], mode:_[1]||"t"};});
            var exFilters=[];
        } else {
            var csv = emAndEx[0].toString().split(/[\t,:;]/);
            var filters = csv.slice(3).map( (_) => _.trim().split(/ +/)).map(
                (_) => {return{filter:_[0], mode:_[1]||"t"};});
            var exs=emAndEx.slice(1).toString().split(/[\t,:;]/);
            var exFilters=exs.slice(0).map( (_) => _.trim().split(/ +/)).map(
                (_) => {return{filter:_[0], mode:_[1]||"t"};});
        }
        sets.push({name: csv[0].trim(),
                   dye: csv[1].trim(),
                   exsource: csv[2].trim(),
                   filters: filters,
                   exFilters: exFilters});
    }
    return sets.sort(function(a, b) {
        var nameA = a.name.toLowerCase(); // ignore upper and lowercase
        var nameB = b.name.toLowerCase(); // ignore upper and lowercase
        if (nameA < nameB) {
            return -1;
        }
        if (nameA > nameB) {
            return 1;
        }
        // names must be equal
        return 0;
    });
}



//=== UI INTERACTION FUNCTIONS ===//
function dropFilter( event, ui) {
    // Add the dropped filter to the active filter set.
    addFilterToSet(ui.draggable.data("key"), "t");
    updatePlot();
}

function dropExFilter( event, ui) {
    // Add the dropped filter to the active filter set.
    addExFilterToSet(ui.draggable.data("key"), "t");
    updatePlot();
}


function addFilterToSet(filter, mode) {
    // Add a filter to the active filter set.
    var el = $(`<div><label>${filter}</label></div>`).addClass("activeFilter");
    EMSET.addFilter(filter, mode);
    mode = mode.toLowerCase();
    el.data("mode", mode);
    el.data("key", filter);
    var buttons = $( "<span></span>").appendTo(el);
    var modeBtn = $(`<button class="modeButton">${mode}</button>`).appendTo(buttons);
    modeBtn.button();
    modeBtn.click(function(){
        var newMode = {"t":"r", "r":"t"}[el.data("mode")];
        EMSET.changeMode(filter,newMode);
        el.data("mode", newMode);
        $( this ).text(newMode);
        updatePlot();
    });
    var delBtn = $(`<button class="delButton">x</button>`).appendTo(buttons);
    delBtn.button();
    delBtn.click(function(){
        EMSET.removeFilter(filter);
        el.remove();
        updatePlot();});
    $( "#fset" ).append(el);
}


function addExFilterToSet(filter, mode) {
    // Add a filter to the active filter set.
    var exl = $(`<div><label>${filter}</label></div>`).addClass("activeExFilter");
    EXSET.addFilter(filter, mode);
    mode = mode.toLowerCase();
    exl.data("mode", mode);
    exl.data("key", filter);
    var buttons = $( "<span></span>").appendTo(exl);
    var modeBtn = $(`<button class="modeButton">${mode}</button>`).appendTo(buttons);
    modeBtn.button();
    modeBtn.click(function(){
        var newMode = {"t":"r", "r":"t"}[exl.data("mode")];
        EXSET.changeMode(filter,newMode);
        exl.data("mode", newMode);
        $( this ).text(newMode);
        updatePlot();
    });
    var delBtn = $(`<button class="delButton">x</button>`).appendTo(buttons);
    delBtn.button();
    delBtn.click(function(){
        EXSET.removeFilter(filter);
        exl.remove();
        updatePlot();});
    $( "#exset" ).append(exl);
}


EVT = null;

function selectDye(event, key) {
    // Update on dye selection.
    s = event.target.closest(".selectable");
    cl = s.classList;
    if( cl && cl.value.includes("selected")) {
        $(s).removeClass("selected");
        EMSET[0].filter = null;
    }
    else
    {
        if (EMSET.length === 0) {
            EMSET.push({"filter":key, "mode":null});
        } else {
            EMSET[0].filter = key;
        }
        $("#dyes .selected").removeClass("selected");
        $(s).addClass("selected");
    }
    updatePlot();
}

//go through all dyes to calc efficencies/brightness
function processAllDyes(dyes){
    var efficiency=[];
    var excitation;
    //save current dye so we can restore it at the end.
    var savedDye = EMSET[0].filter;
    //loop through all dyes and use each in turn
    for (var dye of dyes) {
        EMSET[0].filter = dye;
        //calculate efficency and push results.
        efficiency.push([dye,calcEffAndBright(EXSET,EMSET)]);
    }
    //sort loist for best excitation
    var bestEx = efficiency.sort(function(a,b){
        if (a[1].e_eff === undefined) {return (1);}
        if (b[1].e_eff === undefined) {return (-1);}
        return (b[1].e_eff-a[1].e_eff);}).slice(0,3);
    //sort list for best emmission
    var bestEm = efficiency.sort(function(a,b){
        if (a[1].t_eff === undefined) {return (1);}
        if (b[1].t_eff === undefined) {return (-1);}
        return (b[1].t_eff-a[1].t_eff);}).slice(0,3);
    //sort list for best brightness
    var bestBright = efficiency.sort(function(a,b){
        if (a[1].bright === undefined) {return (1);}
        if (b[1].bright === undefined) {return (-1);}
        return (b[1].bright-a[1].bright);}).slice(0,3);
    //construct output dialog string.
    var bestExString = "Best Excitation:\t ";
    var bestEmString = "\nBest Emission:\t ";
    var bestBrightString = "\nBrightest:\t ";

    //add NUMOPTDYES to each "best" string.
    for (var i=0; i < NUMTOPDYES; i++) {
        bestExString = (bestExString + bestEx[i][0]+" - "+
                        (bestEx[i][1].e_eff*100).toFixed(1)+"% ; ");
        bestEmString = (bestEmString + bestEm[i][0]+" - "+
                        (bestEm[i][1].t_eff*100).toFixed(1)+"% ; ");
        bestBrightString = (bestBrightString + bestBright[i][0]+" - "+
                            (bestBright[i][1].bright).toFixed(2)+" ; ");
    }
    //    console.log(bestEx, bestEm,bestBright)
    //display alert with optimised lists.
    alert(bestExString + bestEmString + bestBrightString);
    //Restore saved dye.
    EMSET[0].filter = savedDye;
}

function selectExcitation(event, key) {
    // Update on excitation selection.
    s = event.target.closest(".selectable");
    cl = s.classList;
    if( cl && cl.value.includes("selected")) {
        $(s).removeClass("selected");
        EXSET[0].filter = null;
    }
    else
    {
        $("#excitation .selected").removeClass("selected");
        $(s).addClass("selected");
        if (EXSET.length === 0) {
            EXSET.push({"filter":key, "mode":null});
        } else {
            EXSET[0].filter = key;
        }
    }
    updatePlot();
}


function selectFilterSet(event, set) {
    if (set === "_adv_") {
        $(".advanced").show();
    } else if (set === "_empty_") {
        $(".advanced").hide();
        $(".activeFilter").remove();
        $(".activeExFilter").remove();
        $("#excitation .selected").removeClass("selected");
        $("#dyes .selected").removeClass("selected");
        EMSET.splice(0);
        EXSET.splice(0);
    } else {
        // Load a pre-defined filter set.
        $(".advanced").hide();
        $(".activeFilter").remove();
        $(".activeExFilter").remove();
        $("#excitation .selected").removeClass("selected");
        $("#dyes .selected").removeClass("selected");
        EMSET.splice(0);
        EXSET.splice(0);
        if (set.dye) {
            if (EMSET.length === 0) {
                EMSET.push({"filter":set.dye, "mode":null});
            } else {
                EMSET[0].filter = set.dye;
                }
            $("#dyes .selected").removeClass("selected");
            $("#dyes .selectable").filter(function() {
                return $(this).data("key") == set.dye;}).addClass("selected");
        } else if (EMSET.length > 0) {
            //EMSET[0] must be the dye, otherwise it is null.
            EMSET[0].filter = null;
        }
        if (set.exsource) {
            if( EXSET.length === 0) {
                EXSET.push({"filter":set.exsource, "mode":null});
            } else {
                EXSET[0].filter=set.exsource;
            }
            $("#excitation .selected").removeClass("selected");
            $("#excitation .selectable").filter(function() {
                return $(this).data("key") == set.exsource;}).addClass("selected");
        } else if (EXSET.length >0) {
            //EXSET[0] must be excitation source, else null.
            EXSET[0].filter = null;
        }
        for (var filter of set.filters) {
            addFilterToSet(filter.filter, filter.mode);
        }
        for (var exFilter of set.exFilters) {
            addExFilterToSet(exFilter.filter, exFilter.mode);
        }
    }
    // Highlight loaded filter set
    let target = $(event.target);
    $("#sets .selectable").removeClass("selected");
    target.closest(".selectable").addClass("selected");
    updatePlot();
}


// Case-insensitive "contains" selector.
$.extend($.expr[":"], {
    "icontains": function(el, i, m, arr) {
        return (el.textContent || el.innerText || "").toLowerCase().indexOf((m[3] || "").toLowerCase()) >= 0;
    }
});


function refineList(event) {
    // Show and hide searchable items based on search key.
    let target = $(event.target);
    let items = $(target.data("search")).children(".searchable");
    if(event.key === "Escape") {
        target.val("");
        items.show();
    } else {
        let val = target.val();
        items.filter(":icontains(" + val + ")").show();
        items.not(":icontains(" + val + ")").hide();
    }
}

//Use url parameter to preload filter sets search
function preloadFilterSetsSearch() {
    var searchFilterSets = getParameterByName("searchFilterSets");
    if(searchFilterSets) {
        //load filterset search field with the value from the URL.
        $("#searchSets")[0].value = searchFilterSets ;
        var event = new Event("keyup",{});
        $("#searchSets")[0].dispatchEvent(event);
    }
}

//=== DOCUMENT READY===//
$( document ).ready(function() {
    $(".advanced").hide();
    // Populate list of filter sets.
    $("<div>").insertBefore($("#sets")).html(
        $("<input>").attr("id", "searchSets").data("search",
                                                   "#sets").keyup(refineList));
    var div = $(`<div><label>CUSTOM</label></div>` );
    div.addClass("selectable");
    div.click((_) => {selectFilterSet(_, "_adv_");});
    div.appendTo($("#sets"));

    div = $(`<div><label>EMPTY</label></div>` );
    div.addClass("searchable").addClass("selectable");
    div.click((_) => {selectFilterSet(_, "_empty_");});
    div.appendTo($("#sets"));

    $.ajax(
        {url: "./sets",
        data: "",
        dataType: "text",
        success: function ( resp ) {
            var divs = [];
            for (let set of parseSets(resp)) {
                var div = $( `<div><label>${set.name}</label></div>` );
                div.click((_) => {selectFilterSet(_, set);});
                div.addClass("searchable");
                div.addClass("selectable");
                divs.push(div);
                }
            $( "#sets" ).append(divs);
            }
        }
    ).then( () =>  {preloadFilterSetsSearch();});

    // Populate list of filters, and store SPECTRA key on the div.data
    $("<div>").insertBefore($("#filters")).html(
        $("<input>").data("search", "#filters").keyup(refineList));
    $.ajax(
        {url: "./filters",
         data: "",
         dataType: "text",
         success: function( resp ) {
             var filters = parseSources(resp);
             var divs = [];
            $.each(filters, function(key, value) {
                SPECTRA[key] = new ServerSpectrum(`filters/${value}`, key);
                var div = $( `<div><label>${key}</label></div>`);
                div.addClass( "filterSpec" );
                div.addClass( "searchable" );
                div.data("key", key);
                divs.push(div);
            });
            $( "#filters" ).append(divs);
            $( ".filterSpec").draggable({helper: "clone", cursor:"move"});
        }
    });
    $( "#fset").droppable({
        accept: ".filterSpec",
        drop: dropFilter
    });

    //excitation filter set list
    $( "#exset").droppable({
        accept: ".filterSpec",
        drop: dropExFilter
    });

    // Populate list of excitation sources.
    $("<div>").insertBefore($("#excitation")).html(
        $("<input>").data("search", "#excitation").keyup(refineList));
    $.ajax(
        {url: "./excitation",
         data: "",
         dataType: "text",
         success: function( data ) {
             var excitations = parseSources(data);
             var divs = [];
            $.each(excitations, function(key, value) {
                var div = $(`<div><label>${key}</label></div>`);
                SPECTRA[key] = new ServerSpectrum(`excitation/${value}`, key);
                div.data("key", key);
                div.addClass("searchable");
                div.addClass("selectable");
                div.click((_) => {selectExcitation(_, key);});
                divs.push(div);
            });
            $( "#excitation" ).append(divs);
        }
    });


    // Populate list of dyes, and store SPECTRA key on the div.data
    $("<div>").insertBefore($("#dyes")).html(
        $("<input>").data("search", "#dyes").keyup(refineList));
    $.ajax(
        {url: "./dyes",
         data: "",
         dataType: "text",
         success: function( data ) {
             var dyes = parseSources(data);
             var divs = [];
            $.each(dyes, function(key, value) {
                var div = $(`<div><label>${key}</label></div>`);
                SPECTRA[key] = new ServerSpectrum(`dyes/${value}`, key);
                div.data("key", key);
                div.addClass("searchable");
                div.addClass("selectable");
                div.click((_) => {selectDye(_, key);});
                divs.push(div);
            });
            $( "#dyes" ).append(divs);
        }
    });
    //set search field if in URL
});

//Global containers for exciation and emission sets.
var EXSET = new FilterSet();
var EMSET = new FilterSet();
