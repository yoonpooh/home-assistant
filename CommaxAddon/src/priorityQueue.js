// priorityQueue.js

class PriorityQueue {
    constructor(comparator = (a, b) => a.priority < b.priority) {
        this.heap = [];
        this.comparator = comparator;
    }

    enqueue(value, priority) {
        const node = { value, priority };
        this.heap.push(node);
        this.#bubbleUp();
    }

    dequeue() {
        const root = this.heap[0];
        const last = this.heap.pop();
        if (this.heap.length > 0) {
            this.heap[0] = last;
            this.#sinkDown();
        }
        return root;
    }

    #bubbleUp() {
        let index = this.heap.length - 1;
        while (index > 0) {
            const parentIdx = Math.floor((index - 1) / 2);
            if (!this.comparator(this.heap[index], this.heap[parentIdx])) break;
            [this.heap[parentIdx], this.heap[index]] = [this.heap[index], this.heap[parentIdx]];
            index = parentIdx;
        }
    }

    #sinkDown() {
        let index = 0;
        const length = this.heap.length;
        while (true) {
            const left = 2 * index + 1;
            const right = 2 * index + 2;
            let swap = null;

            if (left < length && this.comparator(this.heap[left], this.heap[index])) {
                swap = left;
            }
            if (right < length && this.comparator(this.heap[right], this.heap[swap ?? index])) {
                swap = right;
            }
            if (swap === null) break;
            [this.heap[index], this.heap[swap]] = [this.heap[swap], this.heap[index]];
            index = swap;
        }
    }

    isEmpty() {
        return this.heap.length === 0;
    }
}

module.exports = PriorityQueue; // CommonJS 방식으로 클래스 내보내기