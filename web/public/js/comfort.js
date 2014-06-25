///////////////////
// form controls //
///////////////////

// populate page
$(document).on('DOMNodeInserted', function(event) {

    $(".nav > .dropdown").on("click", function(event) {
        $(".nav > .dropdown").removeClass('active');
        $( this ).addClass('active');
    });

    // control intervals for periodic updates
    var weatherinterval = -1;

    if (event.target.id == 'comfort-home-div') {
        // populate weather
        var interval = setInterval(function() {
            if (config.location.value == undefined) {
                return;
            }
            clearInterval(interval);
            populateWeather();
            getWeather();
            weatherinterval = setInterval(function(){ populateWeather(); getWeather(); }, 300000);
        }, 200);
        // don't refresh if we click away
        $("#comfort-home-div").on('remove', function () {
            clearInterval(weatherinterval);
            weatherinterval = -1;
        });
    }

    // sensors

    if (event.target.id == 'comfort-sensors-div') {
        //sensors nav bar
        var interval = setInterval(function() {
            if (sensors == undefined) {
                return;
            }
            clearInterval(interval);
            populateSensors();
        }, 200);
    }

    // sensorgroups
    if (event.target.id == 'comfort-sensorgroups-div') {
        //sensorgroup nav bar
        var interval = setInterval(function() {
            if (sensorgroups == undefined) {
                return;
            }
            clearInterval(interval);
            populateSensorGroups();
        }, 200);

        // save new sensor group or save name
        $("#sensorgroup-name-save").on("click", function(event) {
            var newname = $("#sensorgroup-name-input").val();
            // if current context is existing sensor group, rename it. Otherwise, create new sensor group
            if ($(".sensorgroup.active > a").length != 0) {
                var sensorgroupid = $(".sensorgroup.active > a")[0].id;
                var newname = $("#sensorgroup-name-input").val();
                $.post("/api/sensorgroups/" + sensorgroupid + "/name", {"value": newname}, function(data) {
                    $("#sensorgroup-name-save").notify(data.text, "info");
                    $(".active.sensorgroup > a").html(newname);
                    getSensorGroups();
                }).error(function(data) {
                    $("#sensorgroup-name-save").notify("error on saving name", "error");
                });
            } else {
                $.ajax({url: "/api/sensorgroups",
                        type: 'PUT',
                        data: {"value": newname},
                        success: function(data) {
                            $("#sensorgroup-name-save").notify(data.text, "info");
                            getSensorGroups();
                        },
                        error: function(data) {
                            $("#sensorgroup-name-save").notify("error on saving newgroup" + $.parseJSON(data.responseText).text, "error");
                        }
                });
            }
        });

        //delete sensorgroup button
        $('#sensorgroup-delete').on('click', function(e) {
            var sensorid = $(".sensorgroup.active > a")[0].id;
            $.ajax({url: "/api/sensorgroups/" + sensorid,
                    type: 'DELETE',
                    success: function(data) {
                        getSensorGroups();
                    },
                    error: function(data) {
                        $("#sensorgroup-delete").notify($.parseJSON(data.responseText).text, "error");
                    }
            });
        });
    } 
});

function renderVoltage(sensor) {
    $.getJSON("/api/sensors/" + sensor[0].id + "/data?value=voltage&hours=1", function (data) {
        if(data.result) {
            var voltage = data.payload[data.payload.length-1].voltage;
            $("#sensor-voltage-value").html(voltage + " V");
            if (voltage > 2.5) {
                $("#sensor-voltage-span").addClass('label-success');
            } else if (voltage > 2.2) {
                $("#sensor-voltage-span").addClass('label-warning');
            } else {
                $("#sensor-voltage-span").addClass('label-danger');
            }
        } else {

        }
    });
}

function getSensorData(sensor, hours, datatype) {
    var graphdata = [];
    var data = JSON.parse($.ajax({
        type: "GET",
        url: "/api/sensors/" + sensor + "/data?value=" + datatype + "&hours=" + config.graphtime.value,
        async: false
    }).responseText);

    if (data.result) {
        for (i = 0; i < data.payload.length; i++) {
            var element = [];
            element[0] = data.payload[i].epoch * 1000;
            element[1] = parseFloat(data.payload[i][datatype]);
            graphdata[i] = element;
        }
    }
    return graphdata;
}

function renderSensorGraph(sensor, value, hours, targetdiv) {
    var temperaturedata = getSensorData(sensor, hours, "temperature");
    var humiditydata    = getSensorData(sensor, hours, "humidity");
    var templabel = 'Degrees ' + config.tempunits.value;
    var humlabel = 'Humidity % ';
    if (temperaturedata.length > 0) {
        var dataset = [{data:humiditydata, label:humlabel, color:"green", lines:{show:true}, yaxis: 2},
                       {data:temperaturedata, label:templabel, color: "#0062E3", lines:{show:true}}];
        var options = {
            axisLabels: {show:true},
            series: {shadowSize:5, lines:{show:true},},
            xaxes: [{mode:"time", timezone: "browser", twelveHourClock: true}],
            yaxes: [{alignTicksWithAxis:1, position:"right", axisLabel:templabel, autoscaleMargin:4},
                    {alignTicksWithAxis:1, position:"left", axisLabel:humlabel}],
            legend: {position:'sw'}
        };

        $.plot(targetdiv, dataset, options );
        targetdiv.css("background", "linear-gradient(to top, #ebebeb , white)");
    }
}

function renderSensorGroupGraph(sensorgroupid, targetdiv) {
    var dataset = [];
    var humlabel = 'Humidity %';
    var templabel = 'Degrees ' + config.tempunits.value;

    for (var sensorid in sensorgroups[sensorgroupid].members) {
        var sensortempdata = getSensorData(sensorid, config.graphtime.value, "temperature");
        dataset.push({data:sensortempdata, label: sensors[sensorid].display_name + " temp", color:"#0062E3", lines:{show:true}});
    }

    for (var sensorid in sensorgroups[sensorgroupid].members) {
        var humiditydata = getSensorData(sensorid, config.graphtime.value, "humidity");
        dataset.push({data:humiditydata, label:sensors[sensorid].display_name + " hum", color:"green", lines:{show:true}, yaxis:2});
    }

    var controllerid = sensorgroups[sensorgroupid].controller_id;
    var options = {};
    if (controllerid != null && controllers[controllerid].setpoint != null) {
        var start    = dataset[0].data[0][0]; 
        var end      = dataset[0].data[dataset[0].data.length - 1][0];
        var setpoint = controllers[controllerid].setpoint;
        var upper    = parseFloat(setpoint) + parseFloat(controllers[controllerid].tolerance);
        var lower    = parseFloat(setpoint) - parseFloat(controllers[controllerid].tolerance);
        dataset.push({data:[[end, upper],[start, upper],[start, lower],[end, lower]], 
                      label:'setpoint', 
                      color:"red", 
                      lines:{show:true, 
                             fill:true,
                             lineWidth:1,
                             fillColor: { colors: [{ opacity: 0.2 }, { opacity: 0.2 }]}
                            },
                              
                      yaxis: getLimitsAxis(controllerid)
                     });

        options = {
            axisLabels: {show:true},
            series: {shadowSize:5, lines:{show:true},},
            xaxes: [{mode:"time", timezone: "browser", twelveHourClock: true}],
            yaxes: [{alignTicksWithAxis:1, position:"right", axisLabel:templabel, min:lower-5, max:upper+5 },
                    {alignTicksWithAxis:1, position:"left", axisLabel:humlabel}],
            legend: {position:'sw'}
        };
    } else {
        options = {
            axisLabels: {show:true},
            series: {shadowSize:5, lines:{show:true},},
            xaxes: [{mode:"time", timezone: "browser", twelveHourClock: true}],
            yaxes: [{alignTicksWithAxis:1, position:"right", axisLabel:templabel },
                    {alignTicksWithAxis:1, position:"left", axisLabel:humlabel}],
            legend: {position:'sw'}
        };
    }

    $.plot(targetdiv, dataset, options );
    targetdiv.css("background", "linear-gradient(to top, #ebebeb , white)");
}

function getLimitsAxis(controllerid) {
    if (controllers[controllerid].type == 'temperature') {
        return 1;
    } else {
        return 2;
    }
}

function populateSensors() {
    for (var key in sensors) {
        var $row = "<li class='sensor'><a id='" + key + "' href='#'>sensor " + key + "</a></li>";
        if (sensors[key].display_name != null) { 
            var $row = "<li class='sensor'><a id='" + key + "' href='#'>" + sensors[key].display_name + "</a></li>";
        }
        $("#sensor-nav-list").append($row);
    }

    // populate info on click
    $(".nav-stacked > .sensor > a").on("click", function(event) {
        $(".nav-stacked > .sensor").removeClass('active');
        $(this).parent().addClass('active');
        renderSensorGraph($(this)[0].id, "temperature", config.graphtime.value, $("#sensor-graph"));
        $("#sensor-name-input").val($(this).html());
        $("#sensor-panel-title").html(event.target.id);
        renderVoltage($(this));
    });

    $(".nav-stacked > .sensor > a").first().trigger("click");

    // save sensor name edit
    $("#sensor-name-save").on("click", function(event) {
        var sensorid = $(".active.sensor > a")[0].id
        var newname = $("#sensor-name-input").val();
        $.post("/api/sensors/" + sensorid + "/name", {"value": newname}, function(data) {
            $("#sensor-name-save").notify(data.text, "info");
            $(".active.sensor > a").html(newname);
            getSensors();
        }).error(function(data) {
            $("#sensor-name-save").notify("error on saving name:" + $.parseJSON(data.responseText).text, "error");
        });
    });
}

function populateSensorGroups(activesensorgroupid) {
    $("#sensorgroup-nav-list").html("");
    var sensornavrow;
    for (var key in sensorgroups) {
        sensornavrow = "<li class='sensorgroup'><a id='"+ sensorgroups[key].id + "' href='#'>" + sensorgroups[key].display_name + "</a></li>";
        $("#sensorgroup-nav-list").append(sensornavrow);
    }

    // add  a + sign to sensorgroup nav
    sensornavrow = "<li class=''><a id='addsensorgroup' class='glyphicon glyphicon-plus label-info'" + 
                   " style='color:white;text-align:center' href='#'></a></li>";
    $("#sensorgroup-nav-list").append(sensornavrow);

    // empty out forms for new sensorgroup registration
    $("#addsensorgroup").on("click", function() {
        //$("#comfort-sensor_groups").trigger("click");
        if ($(".active.sensorgroup") != undefined) {
            $(".active.sensorgroup").removeClass("active");
        }
        $("#sensorgroup-name-input").val('enter group name');
        $("#sensorgroup-controllerselect-list").html('');
        $("#sensorgroup-sensorselect-list").html('');
        $("#sensorgroup-controllerselect-dropdown").addClass('hidden');
        $("#sensorgroup-sensorselect-dropdown").addClass('hidden');
    });

    // populate info on selected sensor group 
    $(".nav-stacked > .sensorgroup > a").on("click", function(event) {
        var sensorgroupid = event.target.id;
        var controllerid = sensorgroups[sensorgroupid].controller_id;
        var controller = controllers[controllerid];
        $(".nav-stacked > .sensorgroup").removeClass('active');
        $(this).parent().addClass('active');
        $("#sensorgroup-name-input").val($(this).html());

        if (controller != undefined) {
            $("#sensorgroup-controllerbar").html(controller.display_name);
        } else {
            $("#sensorgroup-controllerbar").html("no controller attached");
        }

        // populate controller select dropdown
        $("#sensorgroup-controllerselect-dropdown").removeClass('hidden');
        $("#sensorgroup-controllerbar").removeClass('hidden');
        $("#sensorgroup-controllerselect-list").html('');
        $("#sensorgroup-controllerselect-list").append('<li><a id="0" class="sensorgroup-controllerlist" href="#">none</a></li>');
        for(var key in controllers) {
            li = '<li><a id="' + key + '" class="sensorgroup-controllerlist" href="#">' + 
                  controllers[key].display_name + '</a></li>'
            $("#sensorgroup-controllerselect-list").append(li);
        }

        // populate sensor select dropdown
        $("#sensorgroup-sensorselect-dropdown").removeClass('hidden');
        $("#sensorgroup-delete").removeClass('hidden');
        $("#sensorgroup-sensorselect-list").html('');
        var sensorgroupid = event.target.id;
        for(var key in sensors) {
            var li;
            if (sensorgroups[sensorgroupid] != undefined && sensorgroups[sensorgroupid].members[key] != undefined) {
                li = '<li><label class="checkbox"><input id="' + key +
                     '" type="checkbox" checked>' + sensors[key].display_name + '</label></li>';
            } else {
                li = '<li><label class="checkbox"><input id="' + key +
                     '" type="checkbox">' + sensors[key].display_name + '</label></li>';
            }
            $("#sensorgroup-sensorselect-list").append(li);
        }

        // save controller on change
        $('#sensorgroup-controllerselect-list > li > a').on('click', function(e) {
             var sensorgroupid = $(".sensorgroup.active > a")[0].id;
             assignControllerToSensorGroup(sensorgroupid, $(this)[0].id);
        });

        // save sensors to sensorgroups
        $('#sensorgroup-sensorselect-list > li > label > input').on('change', function(e) {
            var sensorid = $(this)[0].id;
            var sensorgroupid = $(".sensorgroup.active > a")[0].id;
            if ($(this).is(':checked')) {
                addSensorToGroup(sensorid, sensorgroupid);
            } else {
                removeSensorFromGroup(sensorid, sensorgroupid);
            }
            getSensorGroups();
        });

        // keep menu open when clicking checkboxes
        $('#sensorgroup-sensorselect-list').on('click', function(e) {
            e.stopPropagation();
        });

        // render group graph
        renderSensorGroupGraph(sensorgroupid, $("#sensorgroup-graph"));
    });

    // select a group to show by default
    if (activesensorgroupid != undefined) {
       $(".sensorgroup > a#" + activesensorgroupid).trigger("click");
    } else {
       $(".sensorgroup").children().last().trigger("click"); 
    }
}

function assignControllerToSensorGroup(sensorgroupid, controllerid) {
    $.ajax({url: "/api/controllers/" + controllerid + "/sensorgroup",
            type: "POST",
            data: {"value":sensorgroupid},
            async: false,
            success: function() {
                if (controllerid == 0) {
                    $("#sensorgroup-controllerselect-dropdown").notify("removed", "info", {autoHideDelay:1000});
                    $("#sensorgroup-controllerbar").html('no controller attached')
                    sensorgroups[sensorgroupid].controller_id = null;
                } else {
                    $("#sensorgroup-controllerselect-dropdown").notify("added", "info", {autoHideDelay:1000});
                    $("#sensorgroup-controllerbar").html(controllers[controllerid].display_name);
                    sensorgroups[sensorgroupid].controller_id = controllerid;
                }
                renderSensorGroupGraph(sensorgroupid, $("#sensorgroup-graph"));
                getSensorGroups();
            },
            error: function(data) { 
                    $("#sensorgroup-controllerselect-dropdown").notify($.parseJSON(data.responseText).text, "error", {autoHideDelay:1000})
            }

    });
}

function addSensorToGroup(sensorid, sensorgroupid) {
    $.ajax({url: "/api/sensorgroups/" + sensorgroupid + "/sensors/" + sensorid,
            type: "PUT",
            async: false,
            success: function() { 
                $("#sensorgroup-sensorselect-dropdown").notify("added", "info", {autoHideDelay:1000}); 
                sensorgroups[sensorgroupid].members[sensorid] = 1; 
                renderSensorGroupGraph(sensorgroupid, $("#sensorgroup-graph"));
            },
            error: function() { $("#sensorgroup-sensorselect-dropdown").notify("failure to add", "error", {autoHideDelay:1000})}
    });
}

function removeSensorFromGroup(sensorid, sensorgroupid) {
    $.ajax({url:     "/api/sensorgroups/" + sensorgroupid + "/sensors/" + sensorid,
            type:    "DELETE",
            async:   false,
            success: function() {
                $("#sensorgroup-sensorselect-dropdown").notify("removed", "info", {autoHideDelay:1000});
                delete sensorgroups[sensorgroupid].members[sensorid]
                renderSensorGroupGraph(sensorgroupid, $("#sensorgroup-graph"));
            },
            error:   function() {$("#sensorgroup-sensorselect-dropdown").notify("failure to remove", "error", {autoHideDelay:1000})}
    });
}

function populateWeather() {
    if ($("#home-location-value") == undefined) {
        return;
    }
    $("#home-location-value").html(config.location.value);
    if (weather != undefined) {
        $("#home-weather-value").html(weather.weather[0].description +
                                      "<img src='http://openweathermap.org/img/w/" + weather.weather[0].icon + ".png' />");
        if (config.tempunits.value == 'Celsius') {
            $("#home-temperature-value").html(((weather.main.temp-273.15)).toFixed(2) + " C");
        } else {
            $("#home-temperature-value").html(((weather.main.temp-273.15) * 1.8 + 32).toFixed(2) + " F");
        }
        $("#home-humidity-value").html(weather.main.humidity + "%");
    }
}
