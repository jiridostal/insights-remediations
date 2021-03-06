'use strict';

const _ = require('lodash');
const P = require('bluebird');
const {v4: uuidv4} = require('uuid');

const config = require('../config');
const errors = require('../errors');
const format = require('./remediations.format');
const generator = require('../generator/generator.controller');
const inventory = require('../connectors/inventory');
const sources = require('../connectors/sources');
const receptorConnector = require('../connectors/receptor');
const log = require('../util/log');
const probes = require('../probes');
const read = require('./controller.read');
const queries = require('./remediations.queries');

const SATELLITE_NAMESPACE = Object.freeze({namespace: 'satellite'});
const SYSTEM_FIELDS = Object.freeze(['id', 'ansible_host', 'hostname', 'display_name']);

const DIFF_MODE = false;
const FULL_MODE = true;

const PENDING = 'pending';
const FAILURE = 'failure';

async function fetchSystems (ids) {
    const systemDetails = await inventory.getSystemDetailsBatch(ids, true);

    return _(ids).map(id => _.get(systemDetails, id)).filter().value();
}

exports.getSatelliteId = function (facts) {
    const satelliteFacts = _.find(facts, SATELLITE_NAMESPACE);

    if (satelliteFacts) {
        return satelliteFacts.facts.satellite_instance_id;
    }

    return null;
};

function filterExecutors (status, excludes = null) {
    if (excludes) {
        // If any of the given excludes isn't in  throw error
        const unknownExcludes = _.difference(excludes, _.filter(excludes, exclude_id =>
            _.find(status, executor => executor.satId === exclude_id)));

        if (!_.isEmpty(unknownExcludes)) {
            throw errors.unknownExclude(unknownExcludes);
        }

        probes.excludedExecutors(excludes);
        status = _.filter(status, executor => !_.includes(excludes, executor.satId));
    }

    return _.filter(status, {status: 'connected'});
}

function findResponseMode (response_mode, executors) {
    if (response_mode) {
        if (!['diff', 'full'].includes(response_mode)) {
            throw new errors.BadRequest('UNKNOWN_RESPONSEMODE', `Response Mode "${response_mode}" does not exist`);
        }

        return (response_mode === 'diff') ? DIFF_MODE : FULL_MODE;
    }

    if (config.fifi.text_update_full === DIFF_MODE) {
        if (_.size(executors) < 200) {
            return FULL_MODE;
        }

        return DIFF_MODE;
    }

    return config.fifi.text_update_full;
}

function findResponseInterval (executors) {
    if (config.fifi.text_update_full === DIFF_MODE) {
        // if in DIFF mode use dynamic config
        if (_.size(executors) < 200) {
            return 5000;
        } else if (_.size(executors) < 400) {
            return 30000;
        } else if (_.size(executors) >= 400) {
            return 60000;
        }
    }

    return config.fifi.text_update_interval;
}

function getReceptor (source) {
    if (!source) {
        return null;
    }

    return _.find(source.endpoints, {default: true});
}

async function fetchReceptorStatus (receptor, account) {
    if (!receptor) {
        return null;
    }

    const result = await receptorConnector.getConnectionStatus(account, receptor.receptor_node);
    return _.get(result, 'status', null);
}

function getName (executor) {
    if (executor.source) {
        return executor.source.name;
    }

    if (executor.id) {
        return `Satellite ${executor.id}`;
    }

    return null;
}

function getStatus (executor) {
    if (!executor.id) {
        return 'no_executor';
    }

    if (!executor.source) {
        return 'no_source';
    }

    if (!executor.receptor) {
        return 'no_receptor';
    }

    if (executor.receptorStatus !== 'connected') {
        return 'disconnected';
    }

    return 'connected';
}

function normalize (satellites) {
    return _.map(satellites, satellite => ({
        satId: satellite.id,
        receptorId: _.get(satellite.receptor, 'receptor_node', null),
        endpointId: _.get(satellite.receptor, 'id', null),
        systems: _.map(satellite.systems, system => _.pick(system, SYSTEM_FIELDS)),
        type: satellite.id ? 'satellite' : null,
        name: getName(satellite),
        status: getStatus(satellite)
    }));
}

exports.getListSize = function (list) {
    return _.size(list);
};

exports.pagination = function (list, total, limit, offset) {
    if (offset >= Math.max(total, 1)) {
        return null;
    }

    list = list.slice(offset, offset + limit);

    return list;
};

exports.resolveUsers = async function (req, remediation) {
    const usernames = remediation.playbook_runs.map(run => {
        return run.created_by;
    });
    const resolvedUsersById = await read.getUsers(req, usernames);

    remediation.playbook_runs.forEach(run => {
        run.created_by = read.getUser(resolvedUsersById, run.created_by);
    });

    return remediation;
};

exports.generatePlaybookRunId = function () {
    return uuidv4();
};

exports.getConnectionStatus = async function (remediation, account) {
    const systemsIds = _(remediation.issues).flatMap('systems').map('system_id').uniq().sort().value();
    const systems = await fetchSystems(systemsIds);

    _.forEach(systems, system => system.satelliteId = exports.getSatelliteId(system.facts));

    const satellites = _(systems).groupBy('satelliteId').mapValues(systems => ({
        id: systems[0].satelliteId,
        // unique by ansible host i.e. if there are two systems with the same ansible identifier then
        // only pick on one of them as we wouldn't be able to tell them apart based on responses from Satellite
        systems: _(systems).sortBy('id').uniqBy(generator.systemToHost).value()
    })).values().value();

    const sourceInfo = await sources.getSourceInfo(_(satellites).map('id').filter().value());

    _.forEach(satellites, satellite => {
        satellite.source = _.get(sourceInfo, satellite.id, null);
        satellite.receptor = getReceptor(satellite.source);
    });

    await P.map(satellites, async satellite => {
        satellite.receptorStatus = await fetchReceptorStatus(satellite.receptor, account);
    });

    return normalize(satellites);
};

exports.filterIssuesPerExecutor = async function (systems, remediationIssues) {
    const executorSystemsById = _.keyBy(systems, 'id');
    const filtered = _(_.cloneDeep(remediationIssues))
    .map(issue => ({
        ...issue,
        systems: _.filter(issue.systems, system => _.has(executorSystemsById, system.system_id))
    }))
    .filter(issue => issue.systems.length)
    .value();

    return filtered;
};

// prepare everything that we need to dispatch work requests to receptor
async function prepareReceptorRequest (
    executor,
    remediation,
    remediationIssues,
    playbook_run_id,
    text_update_full,
    text_update_interval) {

    const filteredIssues = generator.normalizeIssues(
        await exports.filterIssuesPerExecutor(executor.systems, remediationIssues)
    );

    const playbook = await generator.playbookPipeline ({
        issues: filteredIssues,
        auto_reboot: remediation.auto_reboot
    }, remediation, false);

    const resolvedIssues = await generator.resolveSystems(filteredIssues);
    const receptorWorkRequest = format.receptorWorkRequest(format.playbookRunRequest(
        remediation,
        resolvedIssues,
        playbook,
        playbook_run_id,
        text_update_full,
        text_update_interval), remediation.account_number, executor.receptorId);

    return { executor, receptorWorkRequest, playbook};
}

function dispatchReceptorRequests (requests, remediation, playbook_run_id) {
    return P.mapSeries(requests, async ({ executor, receptorWorkRequest }, index) => {
        try {
            probes.splitPlaybookPerSatId(receptorWorkRequest, executor.satId, remediation, playbook_run_id);
            const response = await receptorConnector.postInitialRequest(receptorWorkRequest);
            probes.receptorJobDispatched(receptorWorkRequest, executor, response, remediation, playbook_run_id);
            return response;
        } catch (e) {
            if (index !== 0) {
                log.error({executor: executor.id, error: e}, 'error sending Playbook to executor');
                return null;
            }

            throw e;
        }
    });
}

function prepareCancelRequest (account_number, executor, playbook_run_id) {
    const receptorCancelRequest = format.receptorCancelRequest(format.playbookCancelRequest(
        playbook_run_id), account_number, executor.get('receptor_node_id'));

    return { executor, receptorCancelRequest };
}

function dispatchCancelRequests (requests, playbook_run_id) {
    return P.mapSeries(requests, async ({ executor, receptorCancelRequest }) => {
        try {
            const response = await receptorConnector.postInitialRequest(receptorCancelRequest);
            probes.receptorCancelDispatched(receptorCancelRequest, executor, response, playbook_run_id);
            return response;
        } catch (e) {
            log.error({executor: executor.id, error: e}, 'error sending cancel request to executor');
        }
    });
}

async function storePlaybookRun (remediation, playbook_run_id, requests, responses, username, text_update_full) {
    requests.forEach(({executor}, index) => {
        executor.id = uuidv4();
        // eslint-disable-next-line security/detect-object-injection
        executor.response = responses[index];
        // eslint-disable-next-line security/detect-object-injection
        executor.dispatched = (responses[index] !== null);
    });

    const run = {
        id: playbook_run_id,
        remediation_id: remediation.id,
        created_by: username
    };

    const executors = requests.map(({executor, playbook}) => ({
        id: executor.id,
        executor_id: executor.satId,
        executor_name: executor.name,
        receptor_node_id: executor.receptorId,
        status: executor.dispatched ? PENDING : FAILURE,
        // null means we wanted to run this but dispatching of the receptor-controller job request failed
        // we still record the entry but mark the executor and systems as FAILURE instantly
        receptor_job_id: executor.dispatched ? executor.response.id : null,
        playbook: playbook.yaml,
        text_update_full,
        playbook_run_id
    }));

    const systems = _.flatMap(requests, ({executor}) => executor.systems.map(system => ({
        id: uuidv4(),
        system_id: system.id,
        system_name: generator.systemToHost(system),
        status: executor.dispatched ? PENDING : FAILURE,
        playbook_run_executor_id: executor.id
    })));

    await queries.insertPlaybookRun(run, executors, systems);
}

exports.createPlaybookRun = async function (status, remediation, username, excludes, response_mode) {
    const playbook_run_id = exports.generatePlaybookRunId();
    const executors = filterExecutors(status, excludes);
    const remediationIssues = remediation.toJSON().issues;
    const text_update_full = findResponseMode(response_mode, executors);
    const text_update_interval = findResponseInterval(executors);

    if (_.isEmpty(executors)) {
        return null;
    }

    const requests = await P.map(executors,
        executor => prepareReceptorRequest(
            executor,
            remediation,
            remediationIssues,
            playbook_run_id,
            text_update_full,
            text_update_interval));

    const responses = await dispatchReceptorRequests(requests, remediation, playbook_run_id);

    await storePlaybookRun(remediation, playbook_run_id, requests, responses, username, text_update_full);

    return playbook_run_id;
};

exports.cancelPlaybookRun = async function (account_number, playbook_run_id, executors) {
    const requests = executors.map(executor => prepareCancelRequest(account_number, executor, playbook_run_id));

    await dispatchCancelRequests(requests, playbook_run_id);
};
