using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace MagicPot.Launcher;

internal sealed class WindowsNamedMutexLease : IDisposable, IAsyncDisposable
{
    private static readonly TimeSpan ReleaseJoinTimeout = TimeSpan.FromSeconds(5);
    private readonly string name;
    private readonly TimeSpan acquireTimeout;
    private readonly TimeSpan retryDelay;
    private readonly CancellationToken cancellationToken;
    private readonly ManualResetEventSlim releaseRequested = new(false);
    private readonly TaskCompletionSource<WindowsNamedMutexLease> acquired = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<object?> finished = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Thread thread;
    private CancellationTokenRegistration cancellationRegistration;
    private Exception? releaseException;
    private int disposed;

    private WindowsNamedMutexLease(string name, TimeSpan acquireTimeout, TimeSpan retryDelay, CancellationToken cancellationToken)
    {
        this.name = name;
        this.acquireTimeout = acquireTimeout;
        this.retryDelay = retryDelay;
        this.cancellationToken = cancellationToken;
        thread = new Thread(Run) { IsBackground = true, Name = "MagicPot named mutex owner" };
    }

    internal static Task<WindowsNamedMutexLease> AcquireAsync(string name, TimeSpan acquireTimeout, TimeSpan retryDelay, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        if (acquireTimeout <= TimeSpan.Zero && acquireTimeout != Timeout.InfiniteTimeSpan) throw new ArgumentOutOfRangeException(nameof(acquireTimeout));
        if (retryDelay <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(retryDelay));
        cancellationToken.ThrowIfCancellationRequested();
        var lease = new WindowsNamedMutexLease(name, acquireTimeout, retryDelay, cancellationToken);
        lease.cancellationRegistration = cancellationToken.Register(static state => ((WindowsNamedMutexLease)state!).releaseRequested.Set(), lease);
        try { lease.thread.Start(); }
        catch
        {
            lease.cancellationRegistration.Dispose();
            lease.releaseRequested.Dispose();
            throw;
        }
        return lease.acquired.Task;
    }

    private void Run()
    {
        Mutex? mutex = null;
        var ownsMutex = false;
        try
        {
            mutex = new Mutex(false, name);
            var stopwatch = Stopwatch.StartNew();
            while (!releaseRequested.IsSet)
            {
                var wait = retryDelay;
                if (acquireTimeout != Timeout.InfiniteTimeSpan)
                {
                    var remaining = acquireTimeout - stopwatch.Elapsed;
                    if (remaining <= TimeSpan.Zero)
                    {
                        acquired.TrySetException(new TimeoutException("Timed out acquiring Windows named mutex."));
                        return;
                    }
                    if (remaining < wait) wait = remaining;
                }

                try { ownsMutex = mutex.WaitOne(wait); }
                catch (AbandonedMutexException) { ownsMutex = true; }
                if (!ownsMutex) continue;

                if (releaseRequested.IsSet || cancellationToken.IsCancellationRequested)
                {
                    mutex.ReleaseMutex();
                    ownsMutex = false;
                    acquired.TrySetCanceled(cancellationToken);
                    return;
                }

                cancellationRegistration.Dispose();
                acquired.TrySetResult(this);
                releaseRequested.Wait();
                mutex.ReleaseMutex();
                ownsMutex = false;
                return;
            }
            acquired.TrySetCanceled(cancellationToken);
        }
        catch (Exception exception)
        {
            if (!acquired.TrySetException(exception)) releaseException = exception;
        }
        finally
        {
            if (ownsMutex)
            {
                try { mutex!.ReleaseMutex(); }
                catch (Exception exception) { releaseException ??= exception; }
            }
            mutex?.Dispose();
            cancellationRegistration.Dispose();
            finished.TrySetResult(null);
            if (!acquired.Task.IsCompletedSuccessfully) releaseRequested.Dispose();
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        releaseRequested.Set();
        if (!thread.Join(ReleaseJoinTimeout))
        {
            Debug.WriteLine("Timed out waiting for the named mutex owner thread to release the mutex.");
            return;
        }
        if (releaseException is not null) Debug.WriteLine("Named mutex release failed: " + releaseException);
        releaseRequested.Dispose();
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        releaseRequested.Set();
        var completed = await Task.WhenAny(finished.Task, Task.Delay(ReleaseJoinTimeout)).ConfigureAwait(false);
        if (completed != finished.Task)
        {
            Debug.WriteLine("Timed out waiting for the named mutex owner thread to release the mutex.");
            return;
        }
        thread.Join();
        if (releaseException is not null) Debug.WriteLine("Named mutex release failed: " + releaseException);
        releaseRequested.Dispose();
    }
}
