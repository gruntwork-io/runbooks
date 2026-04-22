package fakes

import (
	"context"
	"sync"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// FakeAwsClient is a scripted AwsClient for tests. Each method either
// returns a canned success response or a queued error — queueing is
// explicit so tests document exactly which call paths they exercise.
//
// FakeAwsClient is safe for concurrent use; every call appends to the
// Calls log and every response/error is guarded by the same mutex.
type FakeAwsClient struct {
	mu sync.Mutex

	// Canned responses.
	Identity *ports.AwsCallerIdentity
	OptIn    ports.AwsRegionOptInStatus

	// Queued errors. The next call to ValidateStaticCredentials or
	// CheckRegionOptInStatus pops from these slices; an empty queue
	// means "return the canned value."
	ValidateErrs []error
	OptInErrs    []error

	// Call log: each entry records the method name and the creds and
	// region passed. Tests assert against this to verify a handler
	// actually hit the expected port method with the expected inputs.
	Calls []AwsCall
}

// AwsCall records a single invocation on FakeAwsClient.
type AwsCall struct {
	Method string
	Creds  ports.AwsCredentials
	Region string
}

// NewFakeAwsClient returns a FakeAwsClient whose ValidateStaticCredentials
// returns the given identity (pass nil to start with no identity set) and
// whose CheckRegionOptInStatus returns AwsRegionOptInEnabled. Tests
// override these fields directly as needed.
func NewFakeAwsClient(identity *ports.AwsCallerIdentity) *FakeAwsClient {
	return &FakeAwsClient{
		Identity: identity,
		OptIn:    ports.AwsRegionOptInEnabled,
	}
}

func (f *FakeAwsClient) ValidateStaticCredentials(ctx context.Context, creds ports.AwsCredentials) (*ports.AwsCallerIdentity, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.Calls = append(f.Calls, AwsCall{Method: "ValidateStaticCredentials", Creds: creds})

	if err := popErr(&f.ValidateErrs); err != nil {
		return nil, err
	}
	return f.Identity, nil
}

func (f *FakeAwsClient) CheckRegionOptInStatus(ctx context.Context, creds ports.AwsCredentials, region string) (ports.AwsRegionOptInStatus, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.Calls = append(f.Calls, AwsCall{Method: "CheckRegionOptInStatus", Creds: creds, Region: region})

	if err := popErr(&f.OptInErrs); err != nil {
		return ports.AwsRegionOptInUnknown, err
	}
	return f.OptIn, nil
}

// QueueValidateErr queues an error to be returned by the next
// ValidateStaticCredentials call. Multiple queued errors are returned in
// FIFO order.
func (f *FakeAwsClient) QueueValidateErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ValidateErrs = append(f.ValidateErrs, err)
}

// QueueOptInErr queues an error to be returned by the next
// CheckRegionOptInStatus call.
func (f *FakeAwsClient) QueueOptInErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.OptInErrs = append(f.OptInErrs, err)
}

func popErr(q *[]error) error {
	if len(*q) == 0 {
		return nil
	}
	err := (*q)[0]
	*q = (*q)[1:]
	return err
}

var _ ports.AwsClient = (*FakeAwsClient)(nil)
