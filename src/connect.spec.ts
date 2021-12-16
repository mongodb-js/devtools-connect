import { connectMongoClient } from '../';
import { EventEmitter } from 'events';
import { MongoClient } from 'mongodb';
import sinon, { stubConstructor } from 'ts-sinon';
import chai, { expect } from 'chai';
import sinonChai from 'sinon-chai';
chai.use(sinonChai);

describe('devtools connect', () => {
  let bus: EventEmitter;

  beforeEach(() => {
    bus = new EventEmitter();
  });

  describe('connectMongoClient', () => {
    class FakeMongoClient extends EventEmitter {
      connect() {}
      db() {}
      close() {}
      topology: any;
      get options(): any {
        return {
          metadata: { driver: { name: 'nodejs', version: '3.6.1' } },
          hosts: ['localhost']
        };
      }
    }

    it('connects once when no AutoEncryption set', async() => {
      const uri = 'localhost:27017';
      const mClient = stubConstructor(FakeMongoClient);
      const mClientType = sinon.stub().returns(mClient);
      mClient.connect.onFirstCall().resolves(mClient);
      const result = await connectMongoClient(uri, {}, bus, mClientType as any);
      expect(mClientType.getCalls()).to.have.lengthOf(1);
      expect(mClientType.getCalls()[0].args).to.deep.equal([uri, {}]);
      expect(mClient.connect.getCalls()).to.have.lengthOf(1);
      expect(result).to.equal(mClient);
    });
    it('connects once when bypassAutoEncryption is true', async() => {
      const uri = 'localhost:27017';
      const opts = { autoEncryption: { bypassAutoEncryption: true } };
      const mClient = stubConstructor(FakeMongoClient);
      const mClientType = sinon.stub().returns(mClient);
      mClient.connect.onFirstCall().resolves(mClient);
      const result = await connectMongoClient(uri, opts, bus, mClientType as any);
      expect(mClientType.getCalls()).to.have.lengthOf(1);
      expect(mClientType.getCalls()[0].args).to.deep.equal([uri, opts]);
      expect(mClient.connect.getCalls()).to.have.lengthOf(1);
      expect(result).to.equal(mClient);
    });
    it('connects twice when bypassAutoEncryption is false and enterprise via modules', async() => {
      const uri = 'localhost:27017';
      const opts = { autoEncryption: { bypassAutoEncryption: false } };
      const mClientFirst = stubConstructor(FakeMongoClient);
      const mClientSecond = stubConstructor(FakeMongoClient);
      const mClientType = sinon.stub();
      const commandSpy = sinon.spy();
      mClientFirst.db.returns({
        admin: () => ({
          command: (...args: any[]) => {
            commandSpy(...args);
            return { modules: ['enterprise'] };
          }
        } as any)
      } as any);
      mClientType.onFirstCall().returns(mClientFirst);
      mClientType.onSecondCall().returns(mClientSecond);
      const result = await connectMongoClient(uri, opts, bus, mClientType as any);
      const calls = mClientType.getCalls();
      expect(calls.length).to.equal(2);
      expect(calls[0].args).to.deep.equal([
        uri, {}
      ]);
      expect(commandSpy).to.have.been.calledOnceWithExactly({ buildInfo: 1 });
      expect(result).to.equal(mClientSecond);
    });
    it('errors when bypassAutoEncryption is falsy and not enterprise', async() => {
      const uri = 'localhost:27017';
      const opts = { autoEncryption: {} };
      const mClientFirst = stubConstructor(FakeMongoClient);
      const mClientSecond = stubConstructor(FakeMongoClient);
      const mClientType = sinon.stub();
      const commandSpy = sinon.spy();
      mClientFirst.db.returns({
        admin: () => ({
          command: (...args: any[]) => {
            commandSpy(...args);
            return { modules: [] };
          }
        } as any)
      } as any);
      mClientType.onFirstCall().returns(mClientFirst);
      mClientType.onSecondCall().returns(mClientSecond);
      try {
        await connectMongoClient(uri, opts, bus, mClientType as any);
      } catch (e: any) {
        return expect(e.message.toLowerCase()).to.include('automatic encryption');
      }
      expect.fail('Failed to throw expected error');
    });
    it('errors when bypassAutoEncryption is falsy, missing modules', async() => {
      const uri = 'localhost:27017';
      const opts = { autoEncryption: {} };
      const mClientFirst = stubConstructor(FakeMongoClient);
      const mClientSecond = stubConstructor(FakeMongoClient);
      const mClientType = sinon.stub();
      const commandSpy = sinon.spy();
      mClientFirst.db.returns({
        admin: () => ({
          command: (...args: any[]) => {
            commandSpy(...args);
            return {};
          }
        } as any)
      } as any);
      mClientType.onFirstCall().returns(mClientFirst);
      mClientType.onSecondCall().returns(mClientSecond);
      try {
        await connectMongoClient(uri, opts, bus, mClientType as any);
      } catch (e: any) {
        return expect(e.message.toLowerCase()).to.include('automatic encryption');
      }
      expect.fail('Failed to throw expected error');
    });

    it('fails fast if there is a fail-fast connection error', async() => {
      const err = Object.assign(new Error('ENOTFOUND'), { name: 'MongoNetworkError' });
      const uri = 'localhost:27017';
      const mClient = new FakeMongoClient();
      const mClientType = sinon.stub().returns(mClient);
      let rejectConnect: (err: Error) => void;
      mClient.close = sinon.stub().callsFake(() => {
        rejectConnect(new Error('discarded error'));
      });
      mClient.connect = () => new Promise((resolve, reject) => {
        rejectConnect = reject;
        setImmediate(() => {
          mClient.emit('serverHeartbeatFailed', { failure: err, connectionId: uri });
        });
      });
      mClient.topology = {
        description: {
          servers: new Map([
            ['localhost:27017', {}]
          ])
        }
      };
      try {
        await connectMongoClient(uri, {}, bus, mClientType as any);
      } catch (e) {
        expect((mClient.close as any).getCalls()).to.have.lengthOf(1);
        return expect(e).to.equal(err);
      }
      expect.fail('Failed to throw expected error');
    });
  });

  describe('integration', () => {
    before(function() {
      if (!process.env.MONGODB_URI) {
        this.skip();
      }
    });

    it('successfully connects to mongod service', async() => {
      const bus = new EventEmitter();
      const client = await connectMongoClient(process.env.MONGODB_URI ?? '', {}, bus, MongoClient);
      expect((await client.db('admin').command({ ping: 1 })).ok).to.equal(1);
      await client.close();
    });
  });
});
