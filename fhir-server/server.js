var fs = require('fs');
var httpServer = require('http');
var path = require('path');
var connect = require('connect');
var mongoose = require('mongoose/');
var restify = require('restify');
var crypto = require('crypto');		//	md5 encryption
var jwt = require('jwt-simple');

var config = require('./config');

var local_port = 8888;

//Hopefully this is never used in production, but (god forbid) you can change this.... walk with god.
var root_url = 'http://localhost:' + local_port;
var replace_url = "http://hl7connect.healthintersections.com.au/svc/fhir";
var mongo_uri = (process.env.PORT) ? config.creds.mongoose_auth_jitsu : config.creds.mongoose_auth_local;

var db = mongoose.connect(mongo_uri),
Schema = mongoose.Schema;

//  initialize server
var mongodbServer = restify.createServer({
    formatters: {
        'application/json': function(req, res, body){
            if(req.params.callback){
                var callbackFunctionName = req.params.callback.replace(/[^A-Za-z0-9_\.]/g, '');
                return callbackFunctionName + "(" + JSON.stringify(body) + ");";
            } else {
                return JSON.stringify(body);
            }
        },
        'application/json+fhir': function(req, res, body){
            if(req.params.callback){
                var callbackFunctionName = req.params.callback.replace(/[^A-Za-z0-9_\.]/g, '');
                return callbackFunctionName + "(" + JSON.stringify(body) + ");";
            } else {
                return JSON.stringify(body);
            }
        },
        'text/html': function(req, res, body){
            return body;
        }
    }
});

mongodbServer.use(restify.bodyParser());

restify.defaultResponseHeaders = function(data) {
    this.header('Access-Control-Allow-Origin', "*");
    this.header('Access-Control-Allow-Headers', 'Accept, Accept-Version, Content-Type, Api-Version, Origin, X-Requested-With, Authorization, token');
};

mongodbServer.on('MethodNotAllowed', function unknownMethodHandler(req, res) {
    if (req.method.toLowerCase() === 'options') {
        
        var allowHeaders = ['Accept', 'Accept-Version', 'Content-Type', 'Api-Version', 'Origin', 'X-Requested-With', 'Authorization', 'token']; // added Origin & X-Requested-With & **Authorization**

        if (res.methods.indexOf('OPTIONS') === -1) res.methods.push('OPTIONS');

        res.header('Access-Control-Allow-Headers', allowHeaders.join(', '));
        res.header('Access-Control-Allow-Methods', res.methods.join(', '));
        res.header('Access-Control-Allow-Origin', req.headers.origin);

        return res.send(200);
    }
    else
      return res.send(new restify.MethodNotAllowedError());
});

//  only authorize if authenticating
config.authorize = config.authenticate && config.authorize;

//  set schemas matching supported FHIR resource types
//  NOTE: "User" is a custom resource (http://www.hl7.org/implement/standards/fhir/other.htm)
var MedicationSchema = new Schema({entry:{content:{Medication:{}}}});
mongoose.model('Medication', MedicationSchema);
var MedicationMongooseModel = mongoose.model('Medication'); // just to emphasize this isn't a Backbone Model

var MedicationStatementSchema = new Schema({entry:{content:{MedicationStatement:{patient:{reference:{value:{}}}}}}});
mongoose.model('MedicationStatement', MedicationStatementSchema);
var MedicationStatementMongooseModel = mongoose.model('MedicationStatement');

var MedicationAdministrationSchema = new Schema({entry:{content:{MedicationAdministration:{patient:{reference:{value:{}}}}}}});
mongoose.model('MedicationAdministration', MedicationAdministrationSchema);
var MedicationAdministrationMongooseModel = mongoose.model('MedicationAdministration');

var ObservationSchema = new Schema({entry:{content:{Observation:{patient:{reference:{value:{}}}}}}});
mongoose.model('Observation', ObservationSchema);
var ObservationMongooseModel = mongoose.model('Observation');

var OrganizationSchema = new Schema({entry:{content:{Organization:{}}}});
mongoose.model('Organization', OrganizationSchema);
var OrganizationMongooseModel = mongoose.model('Organization');

var PatientSchema = new Schema({entry:{content:{Patient:{}}}});
mongoose.model('Patient', PatientSchema);
var PatientMongooseModel = mongoose.model('Patient');

var PractitionerSchema = new Schema({entry:{content:{Practitioner:{}}}});
mongoose.model('Practitioner', PractitionerSchema);
var PractitionerMongooseModel = mongoose.model('Practitioner');

var SubstanceSchema = new Schema({entry:{content:{Substance:{}}}});
mongoose.model('Substance', SubstanceSchema);
var SubstanceMongooseModel = mongoose.model('Substance');

var UserSchema = new Schema({entry:{content:{User:{}}}});
mongoose.model('User', UserSchema);
var UserMongooseModel = mongoose.model('User');

var format_fhir = function (entries) {
    //TODO put JSON definition of the document junk here
    var entry_array = new Array();
    var date = new Date();
    var dateString = date.toISOString();
    for (var i = 0; i < entries.length; i++) {
        entries[i].entry.updated = dateString;
        entry_array.push(entries[i].entry);
    }
    var finished_doc = {
        'totalResults': entries.length,
        'link': [],
        'updated': dateString,
        'entries': entry_array
    };
    return finished_doc;
};

/**
 * Searches a resource (by title only)
 * 
 * @req Request object (restify)
 * @res Response object  (restify)
 * @next 
 * @model Mongoose model corresponding to the FHIR resource
 * @resourceId String representing FHIR resource
 */
var searchResource = function (req, res, next, model, resourceId) {

    if ('OPTIONS' == req.method) {
        res.send(203, 'OK');
    }
    
    console.log("searchResource", resourceId, req.params[0]);
    
    model.find({
        "entry.title": new RegExp('^' + resourceId + '.*' + req.params[0])
    }).execFind(function (arr, data) {
        if (data.length > 0) {
            data[0].entry.published = new Date().toISOString();
            res.send(data[0]);
        } else {
            res.send(404, 'Not found');
        }
    });
};

/**
 * Searches a resource
 * 
 * @req Request object (restify)
 * @res Response object  (restify)
 * @next 
 * @model Mongoose model corresponding to the FHIR resource
 * @resourceId String representing FHIR resource
 * @queryDefinitions Object representing searchable fields
 *  {
 *      `id`: "name",                 //  parameter in request containing value to search for
 *      `field`: "name.family.value", //  path to property in @resourceId FHIR resource, after "entry.content.ResourceName."
 *      `search`: [..]                //  array of search type objects, if more than one will result in an "$or" expression
 *          `regex`: "^{{value}}.*"   //  regex for value matching, where {{value}} is replaced by request value if present
 *          `prefix`: "patient/@"     //  prefix for value matching, if not regex
 *  }
 */
var searchResourceParams = function (req, res, next, model, resourceId, queryDefinitions) {

    if ('OPTIONS' == req.method) {
        res.send(203, 'OK');
    }

    console.log("searchResourceParams", resourceId, req.params[0]);

    query = {};
    
    //  if authorization is enabled and resource has a patient resource reference, 
    //  add a query clause specifying that only those resources that match the access
    //  token passed in the request header
    if( config.authorize 
        && new model().schema.path("entry.content." + resourceId + ".patient.reference.value") != undefined ) {
        
        if( req.headers.token )
        {
            var user = jwt.decode(req.headers.token.toString(),config.authentication_secret);
            query["entry.content." + resourceId + ".patient.reference.value"] = 'patient/@' + user.id;
        }
        else
        {
            res.send(401,"Unauthorized");
        }
    }
    
    var params = [];
    
    if( req.method == "GET" )
    {
        var url = require('url');
        params = url.parse(req.url, true).query;
        
        //  trim quotes from parameters
        for (key in params)
        {
            var temp = params[key];
            var firstChar = temp.charAt(0);
            var lastChar = temp.charAt(temp.length-1);

            if (firstChar==lastChar && (firstChar=="'" || firstChar=='"'))
                params[key] = temp.substring(1,temp.length-1);
        }
    }
    
    //  dynamically construct the query based on mapping the query definitions
    //  against the request
    for(var q in queryDefinitions)
    {
        var definition = queryDefinitions[q];
        
        if (params[definition.id]!=undefined) 
        {
            var queryElements = [];
            
            for(var s in definition.search)
            {
                var fieldName = definition.search[s].field ? definition.search[s].field : definition.field;
                var propName = "entry.content." + resourceId + "." + fieldName;
                
                var queryElement = {};
                
                if( definition.search[s].regex )
                {
                    queryElement[propName] = new RegExp(definition.search[s].regex.replace("{{value}}",params[definition.id]), definition.search[s].flags );
                }
                else
                {
                    queryElement[propName] = (definition.search[s].prefix?definition.search[s].prefix:"") + params[definition.id];
                }
                
                queryElements.push( queryElement );
            }
            
            if( queryElements.length > 1 )
                query['$or'] = queryElements;
            else
                for(var p in queryElements[0])
                    query[p] = queryElements[0][p];
        }
    }
    
    console.log( query );
    
    var entries = [];
    
    //  node crashes when collection length exceeds 1000, so stream
    model.find(query).stream().on('data', function (data) {
        entries.push(data);
    }).on('close', function () {
        if( res.statusCode != 401 )
            res.send(format_fhir(entries));
    });
};

/**
 * Deletes a resource
 * 
 * @req Request object (restify)
 * @res Response object (restify)
 * @next 
 * @model Mongoose model corresponding to the FHIR resource
 * @resourceId String representing FHIR resource
 * 
 * @TODO implement auth
 */
var deleteResource = function (req, res, next, model, resourceId) {

    if ('OPTIONS' == req.method) {
        res.send(203, 'OK');
    }

    console.log("deleteResource", resourceId, req.params[0]);

    model.find({
        "entry.title": new RegExp('^' + resourceId + '.*' + req.params[0])
    }).execFind(function (arr, data) {
        if (data.length > 0) {
            data[0].remove();
            res.send(204,'No content');
        } else {
            res.send(404, 'Not found');
        }
    });
};

/**
 * Gets all records for a resource
 * 
 * @req Request object (restify)
 * @res Response object (restify)
 * @next 
 * @model Mongoose model corresponding to the FHIR resource
 * @resourceId String representing FHIR resource
 * 
 * @TODO implement auth
 */
var getResourceHistory = function (req, res, next, model, resourceId) {

    if ('OPTIONS' == req.method) {
        res.send(203, 'OK');
    }

    console.log("getResourceHistory", resourceId);

    model.find({
        "entry.title": new RegExp('^' + resourceId)
    }).execFind(function (arr, data) {
        res.send(format_fhir(data));
    });
};

/**
 * Saves a records for en masse a resource
 * 
 * @req Request object (restify)
 * @res Response object (restify)
 * @next 
 * @model Mongoose model corresponding to the FHIR resource
 * @resourceId String representing FHIR resource
 * 
 * @TODO deprecate for puts
 */
var postDump = function (req, res, next, model, resourceId) {

    if ('OPTIONS' == req.method) {
        res.send(203, 'OK');
    }

    console.log("postDump", resourceId, req.body);

    var entry = req.body.replace(new RegExp("{{hostname}}", 'g'), root_url);

    // Create a new message model, fill it up and save it to Mongodb
    var item = new model();
    item.entry = JSON.parse(entry);
    item.save(function () {
        res.send(entry); //TODO, actual response code? How about validation?
    });
};

if( config.authenticate ) {
    var postAuthenticate = function (req, res, next) {
 
        if ('OPTIONS' == req.method) {
            res.send(203, 'OK');
        }
        
        var request = JSON.parse(req.body);
        var username = request.username;
        var password = request.password;

        query = { "entry.content.User.login.text.value": username, "entry.content.User.password.value": encrypt(password) };
        
        UserMongooseModel.findOne(query).execFind(function (arr, data) {
            if (data.length) {
                var user = data[0].entry.content.User;
                var response = {user:user};
                var token = jwt.encode({id: data[0]._id}, config.authentication_secret);
                
                response.id = data[0]._id;
                response.token = token;
                res.send(response);
            } else
                res.send(404, 'Not found');
        });
    };
}

var putResource = function (req, res, next, model, resourceId) {

    if ('OPTIONS' == req.method) {
        res.send(203, 'OK');
    }

    var resource = JSON.parse(req.body);

    if (req.params && req.params[0]) {
        model.find({
            "entry.title": new RegExp('^' + resourceId + '.*' + req.params[0])
        }).execFind(function (arr, data) {
            if (data.length > 0) {
                updateData(req.params[0], resource, data[0], req.connection.remoteAddress, res, model);
            } else {
                newData(createUUID(), resource, req.connection.remoteAddress, res, model);
            }
        });
    } else {
        newData(createUUID(), resource, req.connection.remoteAddress, res, model);
    };
};

var putUser = function (req, res, next) {

    if ('OPTIONS' == req.method) {
        res.send(203, 'OK');
    }
    
    var data = JSON.parse(req.body);
    
    data.User.password.value = encrypt(data.User.password.value);
    req.body = JSON.stringify(data);
    
    putResource(req, res, next, UserMongooseModel, 'User');
};

var updateData = function (uuid, data, message, remoteAddress, res, model) {
    
    var type = "";
    for (var key in data) {
        type = key;
    }

    var item = new model();
    item.entry = message.entry;

    model.remove({
        "entry.title": new RegExp('^' + type + '.*' + uuid)
    }, function (err) {
        console.log(err);

        item.entry.updated = new Date().toISOString();
        item.entry.published = new Date().toISOString();
        item.entry.content = data;
        item.entry.author = [{
            'name': remoteAddress
        }];
        item.entry.summary = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n" + data[type].text.div;
        item.save(function () {
            res.send(data); //TODO, actual response code? How about validation?
        });
    });
};

var newData = function (uuid, data, remoteAddress, res, model) {

    var type = "";
    for (var key in data) {
        type = key;
    }

    var lowercase = type.toLowerCase();

    console.log( 'contentType=' + res.contentType );
    
    var item = new model();
    var entry = {
        'title': key + ' \"' + uuid + '\" Version \"1\"',
        'id': 'http://localhost:8888/' + lowercase + '/@' + uuid,
        'link': [{
            "href": "http://localhost:8888/" + lowercase + "/@" + uuid + "/@1",
            "rel": "self"
        }],
        'updated': new Date().toISOString(),
        'published': new Date().toISOString(),
        'author': [{
            'name': remoteAddress
        }],
        'content': data,
        'summary': "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n" + data[type].text.div
    };
    
    item.entry = entry;
    item.save(function () {
        res.send(item); //TODO, actual response code? How about validation?
    });
};

/**
 * Utility functions
 */
var createUUID = function () {
    var d = new Date().getTime();
    var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = (d + Math.random() * 16) % 16 | 0;
        d = Math.floor(d / 16);
        return (c == 'x' ? r : (r & 0x7 | 0x8)).toString(16);
    });
    return uuid;
};

var encrypt = function (string) {
    return crypto.createHash('md5').update(string).digest('hex');
};

mongodbServer.listen(local_port, function () {

    var consoleMessage = '\n Simple Fhir server api: port ' + local_port;
    consoleMessage += '\n - /observation/history \n';
    consoleMessage += ' - /observation/searchResource \n';
    consoleMessage += ' - /observation/@:refid \n';

    consoleMessage += ' - /patient/history \n';
    consoleMessage += ' - /patient/searchResource \n';
    consoleMessage += ' - /patient/@:refid \n';

    consoleMessage += ' - /practitioner/history \n';
    consoleMessage += ' - /practitioner/searchResource \n';
    consoleMessage += ' - /practitioner/@:refid \n';

    consoleMessage += '++++++++++++++++++++++++++++++++++++++++++ \n\n';

    console.log(consoleMessage, mongodbServer.name, mongodbServer.url);

});

//	get all records
mongodbServer.get('/medication/history', function(req, res, next){return getResourceHistory(req, res, next, MedicationMongooseModel, 'Medication');});
mongodbServer.get('/medicationadministration/history', function(req, res, next){return getResourceHistory(req, res, next, MedicationAdministrationMongooseModel, 'MedicationStatement');});
mongodbServer.get('/medicationstatement/history', function(req, res, next){return getResourceHistory(req, res, next, MedicationStatementMongooseModel, 'MedicationStatement');});
mongodbServer.get('/observation/history', function(req, res, next){return getResourceHistory(req, res, next, ObservationMongooseModel, 'Observation');});
mongodbServer.get('/organization/history', function(req, res, next){return getResourceHistory(req, res, next, OrganizationMongooseModel, 'Organization');});
mongodbServer.get('/patient/history', function(req, res, next){return getResourceHistory(req, res, next, PatientMongooseModel, 'Patient');});
mongodbServer.get('/practitioner/history', function(req, res, next){return getResourceHistory(req, res, next, PractitionerMongooseModel, 'Practitioner');});
mongodbServer.get('/substance/history', function(req, res, next){return getResourceHistory(req, res, next, SubstanceMongooseModel, 'Substance');});

//	write new records
mongodbServer.put(/^\/medication\/@([a-zA-Z0-9_\.~-]+)/, function(req, res, next){return putResource(req, res, next, MedicationMongooseModel, 'Medication');});
mongodbServer.put(/^\/medicationadministration\/@([a-zA-Z0-9_\.~-]+)/,  function(req, res, next){return putResource(req, res, next, MedicationAdministrationMongooseModel, 'MedicationAdministration');});
mongodbServer.put(/^\/medicationstatement\/@([a-zA-Z0-9_\.~-]+)/,  function(req, res, next){return putResource(req, res, next, MedicationStatementMongooseModel, 'MedicationStatement');});
mongodbServer.put(/^\/observation\/@([a-zA-Z0-9_\.~-]+)/, function(req, res, next){return putResource(req, res, next, ObservationMongooseModel, 'Observation');});
mongodbServer.put(/^\/organization\/@([a-zA-Z0-9_\.~-]+)/, function(req, res, next){return putResource(req, res, next, OrganizationMongooseModel, 'Organization');});
mongodbServer.put(/^\/patient\/@([a-zA-Z0-9_\.~-]+)/, function(req, res, next){return putResource(req, res, next, PatientMongooseModel, 'Patient');});
mongodbServer.put(/^\/practitioner\/@([a-zA-Z0-9_\.~-]+)/, function(req, res, next){return putResource(req, res, next, PractitionerMongooseModel, 'Practitioner');});
mongodbServer.put('/^\/user\/@([a-zA-Z0-9_\.~-]+)/', function(req, res, next){return putUser(req, res, next);});
mongodbServer.put('/medication', function(req, res, next){return putResource(req, res, next, MedicationMongooseModel, 'Medication');});
mongodbServer.put('/medicationadministration',  function(req, res, next){return putResource(req, res, next, MedicationAdministrationMongooseModel, 'MedicationAdministration');});
mongodbServer.put('/medicationstatement', function(req, res, next){return putResource(req, res, next, MedicationStatementMongooseModel, 'MedicationStatement');});
mongodbServer.put('/observation', function(req, res, next){return putResource(req, res, next, ObservationMongooseModel, 'Observation');});
mongodbServer.put('/organization', function(req, res, next){return putResource(req, res, next, OrganizationMongooseModel, 'Organization');});
mongodbServer.put('/patient', function(req, res, next){return putResource(req, res, next, PatientMongooseModel, 'Patient');});
mongodbServer.put('/practitioner', function(req, res, next){return putResource(req, res, next, PractitionerMongooseModel, 'Practitioner');});
mongodbServer.put('/user', function(req, res, next){return putUser(req, res, next);});

//	search
mongodbServer.get('/medication/search', function(req,res,next) {
    return searchResourceParams(
                req,res,next,MedicationMongooseModel,'Medication',
                [
                 {id:"name",field:"name.value",search:[{regex:'^{{value}}.*'},{prefix:''}]}
                ]
            );
});
mongodbServer.get('/medicationadministration/search', function(req,res,next) {
    return searchResourceParams(
                req,res,next,MedicationAdministrationMongooseModel,'MedicationAdministration',
                [
                 {id:"patient_id",field:"patient.reference.value",search:[{prefix:'patient/@'}]}
                ]
            );
});
mongodbServer.get('/medicationstatement/search', function(req,res,next) {
    return searchResourceParams(
            req,res,next,MedicationStatementMongooseModel,'MedicationStatement',
            [
             {id:"patient_id",field:"patient.reference.value",search:[{prefix:'patient/@'}]}
            ]
    );
});
 
mongodbServer.get('/observation/search', function(req,res,next) {
    return searchResourceParams(
            req,res,next,ObservationMongooseModel,'Observation',
            [
             {id:"subject",field:"subjet.reference.value",search:[{prefix:'patient/@'}]},
             {id:"performer",field:"performer.reference.value",search:[{regex:'((practitioner)|(patient))/@{{value}}'}]},
             {id:"subject.name",field:"subject.display.value",search:[{regex:'{{value}}',flags:'i'}]},
             {id:"performer.name",field:"performer.display.value",search:[{regex:'{{value}}',flags:'i'}]},
             {id:"name",search:[{field:"name.coding.code.value"},{field:"name.coding.code.value"},{field:"name.coding.display.value",regex:'.*{{value}}.*',flags:'i'}]}
            ]
    );
});
mongodbServer.get('/organization/search', function(req,res,next){
    return searchResourceParams(
            req,res,next,OrganizationMongooseModel,'Organization',
            [
             {id:"name",field:"name.value",search:[{regex:'^{{value}}.*'}]}
            ]
    );
});
mongodbServer.get('/patient/search', function(req,res,next) {
    return searchResourceParams(
            req,res,next,PatientMongooseModel,'Patient',
            [
             {id:"name",search:[{field:"name.family.value",regex:'^{{value}}.*'},{field:"name.given.value",regex:'^{{value}}.*'}]},
             {id:"family",search:[{field:"name.family.value",regex:'^{{value}}.*'}]},
             {id:"given",search:[{field:"name.given.value",regex:'^{{value}}.*'}]}
            ]
        );
});
mongodbServer.get('/practitioner/search', function(req,res,next) {
    return searchResourceParams(
            req,res,next,PractitionerMongooseModel,'Practitioner',
            [
             {id:"name",search:[{field:"name.family.value",regex:'^{{value}}.*'},{field:"name.given.value",regex:'^{{value}}.*',flags:'i'}]},
             {id:"family",search:[{field:"name.family.value",regex:'^{{value}}.*',flags:'i'}]},
             {id:"given",search:[{field:"name.given.value",regex:'^{{value}}.*',flags:'i'}]}
            ]
        );
});
mongodbServer.get('/user/search', function(req,res,next) {
    return searchResourceParams(
            req,res,next,UserMongooseModel,'User',
            [
             {id:"username",search:[{field:"login.value"}]}
            ]
        );
});

//	find specific records
mongodbServer.get(/^\/medication\/@([a-zA-Z0-9_\.~-]+)/, function(req, res, next){return searchResource(req, res, next, MedicationMongooseModel, 'Medication');});
mongodbServer.get(/^\/medicationadministration\/@([a-zA-Z0-9_\.~-]+)/, function(req, res, next){return searchResource(req, res, next, MedicationAdministrationMongooseModel, 'MedicationAdministration');});
mongodbServer.get(/^\/medicationstatement\/@([a-zA-Z0-9_\.~-]+)/, function(req, res, next){return searchResource(req, res, next, MedicationStatementMongooseModel, 'MedicationStatement');});
mongodbServer.get(/^\/observation\/@([a-zA-Z0-9_\.~-]+)/, function(req, res, next){return searchResource(req, res, next, ObservationMongooseModel, 'Observation');});
mongodbServer.get(/^\/organization\/@([a-zA-Z0-9_\.~-]+)/, function(req, res, next){return searchResource(req, res, next, OrganizationMongooseModel, 'Organization');});
mongodbServer.get(/^\/patient\/@([a-zA-Z0-9_\.~-]+)/, function(req, res, next){return searchResource(req, res, next, PatientMongooseModel, 'Patient');});
mongodbServer.get(/^\/practitioner\/@([a-zA-Z0-9_\.~-]+)/, function(req, res, next){return searchResource(req, res, next, PractitionerMongooseModel, 'Practitioner');});
mongodbServer.get(/^\/substance\/@([a-zA-Z0-9_\.~-]+)/, function(req, res, next){return searchResource(req, res, next, SubstanceMongooseModel, 'Substance');});

//	delete
mongodbServer.del(/^\/medicationadministration\/delete\/@([a-zA-Z0-9_\.~-]+)/, function(req, res, next){return deleteResource(req, res, next, MedicationAdministrationMongooseModel, 'MedicationAdministration');});
mongodbServer.del(/^\/medicationstatement\/delete\/@([a-zA-Z0-9_\.~-]+)/, function(req, res, next){return deleteResource(req, res, next, MedicationStatementMongooseModel, 'MedicationStatement');});

//	recieve record dumps
//  (corresponds to resources listed in test_data/load.sh import script)
mongodbServer.post('/medicationDump', function(req, res, next){return postDump(req,res,next,MedicationMongooseModel,'Medication');});
mongodbServer.post('/observationDump', function(req, res, next){return postDump(req,res,next,ObservationMongooseModel,'Observation');});
mongodbServer.post('/organizationDump', function(req, res, next){return postDump(req,res,next,OrganizationMongooseModel,'Organization');});
mongodbServer.post('/patientDump', function(req, res, next){return postDump(req,res,next,PatientMongooseModel,'Patient');});
mongodbServer.post('/practitionerDump', function(req, res, next){return postDump(req,res,next,PractitionerMongooseModel,'Practitioner');});
mongodbServer.post('/substanceDump', function(req, res, next){return postDump(req,res,next,SubstanceMongooseModel,'Substance');});

//	user authentication
if( config.authenticate )
    mongodbServer.post('login', postAuthenticate);