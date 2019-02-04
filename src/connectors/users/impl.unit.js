'use strict';

const impl = require('./impl');
const base = require('../../test');
const Connector = require('../Connector');
const { mockRequest } = require('../testUtils');

const MOCK_USER = {
    org_id: '1979710',
    username: '***REMOVED***',
    account_number: '540155',
    is_active: true,
    locale: 'en_US',
    id: 7166102,
    email: 'jharting@redhat.com',
    first_name: 'Jozef',
    last_name: 'Hartinger',
    address_string: '\'Jozef Hartinger\' jharting@redhat.com',
    is_org_admin: true,
    is_internal: true
};

describe('inventory impl', function () {

    beforeEach(mockRequest);

    test('obtains user info', async function () {
        const spy = base.getSandbox().stub(Connector.prototype, 'doHttp').resolves([MOCK_USER]);
        const result = await impl.getUser('***REMOVED***');
        result.should.have.property('username', '***REMOVED***');
        result.should.have.property('first_name', 'Jozef');
        result.should.have.property('last_name', 'Hartinger');

        spy.callCount.should.equal(1);
        const options = spy.args[0][0];
        options.headers.should.have.size(3);
        options.headers.should.have.property('x-rh-apitoken', '');
        options.headers.should.have.property('x-rh-insights-env', 'prod');
        options.headers.should.have.property('x-rh-insights-request-id', 'request-id');
    });

    test('returns null when user does not exist', async function () {
        base.getSandbox().stub(Connector.prototype, 'doHttp').resolves([]);
        expect(impl.getUser('***REMOVED***')).resolves.toBeNull();
    });

    test('ping', async function () {
        base.getSandbox().stub(Connector.prototype, 'doHttp').resolves([MOCK_USER]);
        await impl.ping();
    });
});