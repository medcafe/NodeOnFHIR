#!/bin/bash
which node
echo -n "loading list...."
out=`node load list`
if [ $? -ne 0 ] ; then
    echo "failed."
    exit 127
else
    echo "ok."
fi

echo -n "loading list...."
out=`node load patient`
if [ $? -ne 0 ] ; then
    echo "failed."
    exit 127
else
    echo "ok."
fi

echo -n "loading list...."
out=`node load practitioner`
if [ $? -ne 0 ] ; then
    echo "failed."
    exit 127
else
    echo "ok."
fi

echo "done.
"
